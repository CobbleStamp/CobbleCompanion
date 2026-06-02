# Multi-stage build for the Phase 0 stack. One shared install layer, then a
# target per service: `api` (Fastify, run via tsx) and `web` (built SPA on nginx).
# Local-dev oriented — production image hardening (bundle/distroless) is Phase 8
# (see docs/architecture.md §8).

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- Install all workspace dependencies once (cached on lockfile) ---
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
COPY db/package.json ./db/
RUN pnpm install --frozen-lockfile

# --- Full source + generated migrations ---
FROM deps AS source
COPY . .
RUN pnpm db:generate

# --- API service: migrate on boot, then serve via tsx ---
FROM source AS api
EXPOSE 3000
CMD ["sh", "-c", "pnpm db:migrate && pnpm --filter @cobble/api run serve"]

# --- Web build: compile the SPA (API URL baked in at build time) ---
FROM source AS web-build
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @cobble/web build

# --- Web service: static SPA on nginx with history-API fallback ---
FROM nginx:alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80
