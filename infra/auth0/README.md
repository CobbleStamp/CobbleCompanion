# infra/auth0 — Auth0 tenant as code

This Pulumi project owns the **CobbleCompanion Auth0 tenant** configuration:
the SPA application, the API resource server, the Google SSO connection link,
the post-login email allowlist, and the Pulumi M2M app + its client grant.
Anything you would otherwise click in the Auth0 dashboard lives here as
TypeScript. (Ported from CobbleBrowse's `infra/auth0`.)

## Decisions

| | |
|---|---|
| Language | TypeScript |
| State backend | AWS S3 (same bucket as CobbleBrowse) |
| Secret encryption | Passphrase (`PULUMI_CONFIG_PASSPHRASE`) |
| Stacks | `dev` only (for now) |
| Provider | `@pulumi/auth0` (pinned in `package.json`, no `^`) |

---

## Phase A — One-time bootstrap (manual)

Pulumi itself depends on these, so they can't live in Pulumi.

### A1. Create a new Auth0 tenant

In the Auth0 dashboard, create a dedicated tenant for CobbleCompanion
(e.g. `cobblecompanion`). Note the tenant domain (e.g.
`cobblecompanion.us.auth0.com`). The default `google-oauth2` social
connection is provisioned automatically.

### A2. Create the Pulumi M2M app

```bash
auth0 tenants use cobblecompanion.us.auth0.com   # select the new tenant
auth0 apps create \
  --name "Pulumi-IaC" \
  --type m2m \
  --reveal-secrets \
  --description "M2M app used by Pulumi to manage the Auth0 tenant"
```

Authorize it for the **Auth0 Management API** with the scopes listed in
`src/m2m.ts` (`*:clients`, `*:client_grants`, `*:resource_servers`,
`*:connections`, `*:users`, `*:actions`). Save the **client id + secret**.

### A3. Get the client-grant id (for the import in Phase C)

```bash
auth0 api get client-grants | jq '.[] | select(.client_id=="<M2M_CLIENT_ID>") | .id'
```

---

## Phase B — Initialize the stack

```bash
cd infra/auth0
export PULUMI_CONFIG_PASSPHRASE="<reuse CobbleBrowse's>"
pulumi login s3://<shared-state-bucket>

# Outside the pnpm-workspace glob, so install standalone.
pnpm install --ignore-workspace

pulumi stack init dev --secrets-provider passphrase

pulumi config set         auth0:domain       cobblecompanion.us.auth0.com
pulumi config set         auth0:clientId     <M2M_CLIENT_ID>
pulumi config set --secret auth0:clientSecret <M2M_CLIENT_SECRET>

pulumi config set         cobblecompanion-auth0:apiAudience https://api.cobblecompanion.local
pulumi config set --path  'cobblecompanion-auth0:allowedEmails[0]' cobblestamp@gmail.com
pulumi config set --path  'cobblecompanion-auth0:spaOrigins[0]' http://localhost:5173
pulumi config set --path  'cobblecompanion-auth0:spaOrigins[1]' http://localhost:3001
```

---

## Phase C — Import the bootstrap M2M app

```bash
pulumi import auth0:index/client:Client pulumi-iac <M2M_CLIENT_ID>
pulumi import auth0:index/clientGrant:ClientGrant pulumi-iac-grant <GRANT_ID>
```

Cross-check the inferred args against `src/m2m.ts`.

---

## Phase D — Apply and wire to the app

```bash
pulumi preview   # should show Create for the SPA, API, Google link, Action
pulumi up

pulumi stack output auth0Domain   # → AUTH0_DOMAIN
pulumi stack output spaClientId   # → AUTH0_CLIENT_ID
pulumi stack output apiAudience   # → AUTH0_AUDIENCE
```

Feed those three into the API env (locally via `.env`; in prod via the
`infra/gcp` stack, which reads `spaClientId` over a StackReference).

After the first Cloud Run deploy, append the `*.run.app` URL:

```bash
pulumi config set --path 'cobblecompanion-auth0:spaOrigins[2]' https://<service>.run.app
pulumi up
```

---

## Day-2 ops

| Task | Command |
|---|---|
| Add an allowed email | `pulumi config set --path 'allowedEmails[N]' alice@example.com` then `pulumi up` |
| Remove an allowed email | `pulumi config rm --path 'allowedEmails[N]'` then `pulumi up` |
| Add an origin | `pulumi config set --path 'spaOrigins[N]' https://…` then `pulumi up` |
| Rotate the M2M secret | rotate in Auth0, then `pulumi config set --secret auth0:clientSecret …` |

## What lives where

| File | Purpose |
|---|---|
| `src/spa.ts` | SPA application (CobbleCompanion Web) |
| `src/api.ts` | API resource server (CobbleCompanion API) |
| `src/m2m.ts` | Pulumi M2M app + client grant (imported, then managed) |
| `src/connections.ts` | Enables the `google-oauth2` connection on the SPA |
| `src/allowlist.ts` | Post-login Action: allowlist gate + `email` access-token claim |
