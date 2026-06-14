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

# --- API service: migrate on boot, then serve via tsx (local dev / compose) ---
FROM source AS api
EXPOSE 3000
CMD ["sh", "-c", "pnpm db:migrate && pnpm --filter @cobble/api run serve"]

# --- Single-origin server: build the SPA, then serve API + SPA on one origin ---
# The Fastify API serves packages/web/dist via @fastify/static (see
# packages/api/src/app.ts). VITE_API_URL is empty so the SPA calls its own
# origin. The host sets PORT (config.ts reads it): GCP Cloud Run injects
# PORT=8080; the AWS EC2 deploy runs this image behind Caddy on localhost:3000.
# EXPOSE is cosmetic (Cloud Run ignores it). Both clouds run this same target —
# see docs/infra-setup.md.
FROM source AS server
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @cobble/web build
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
