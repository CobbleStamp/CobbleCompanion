# infra — Pulumi infrastructure

Two Pulumi (TypeScript) projects provision everything CobbleCompanion needs to
run in the cloud:

| Project | Owns | README |
|---|---|---|
| [`auth0/`](./auth0/README.md) | Auth0 tenant config — SPA app, API resource server, Google SSO connection, post-login email allowlist | `auth0/README.md` |
| [`gcp/`](./gcp/README.md) | One Cloud Run service (Fastify API + built SPA), Artifact Registry, Secret Manager, IAM | `gcp/README.md` |

Both share one AWS S3 state backend and the same `PULUMI_CONFIG_PASSPHRASE`.

**Almost everything is managed as code.** Two things can't be — they're the
credentials/accounts that Pulumi authenticates *with*, so they must exist before
Pulumi can run:

- **Auth0:** the tenant + the Pulumi M2M app (documented below).
- **GCP:** the project + billing link (see `gcp/README.md` Phase A).

---

## Auth0 manual bootstrap (one-time)

Pulumi's `@pulumi/auth0` provider talks to the Auth0 **Management API** using
M2M client credentials. You can't use Pulumi to create the credential Pulumi
needs to authenticate — so the tenant and that one M2M app are created by hand,
then the M2M app is **imported** into Pulumi state (`auth0/src/m2m.ts` uses
`{ import: clientId }`) so all later changes are versioned. After this, never
touch the Auth0 dashboard again — edit `infra/auth0/` and `pulumi up`.

You need the [Auth0 CLI](https://github.com/auth0/auth0-cli)
(`brew install auth0/auth0-cli/auth0`) or the dashboard. CLI steps shown.

> **Shortcut:** steps 3–6 are pure Management-API calls and are scripted in
> [`scripts/auth0-bootstrap.sh`](../scripts/auth0-bootstrap.sh) (idempotent).
> After doing steps 1–2 (create the tenant, `auth0 login`), run:
> ```bash
> scripts/auth0-bootstrap.sh --domain cobblecompanion.us.auth0.com
> ```
> It creates/reuses the M2M app, grants the scopes, prints the client id /
> secret / grant id, and emits the exact `pulumi config set` + `pulumi import`
> commands for `auth0/README.md` Phase B. The manual steps below are the same
> thing by hand.

### 1. Create the tenant

In the [Auth0 dashboard](https://manage.auth0.com), create a new tenant for
CobbleCompanion (top-left tenant switcher → **Create tenant**), e.g. region
`US`, name `cobblecompanion`. Note the **tenant domain** it gives you, e.g.
`cobblecompanion.us.auth0.com` — this becomes `auth0:domain`.

> The CLI/provider manage resources *inside* a tenant; they don't create the
> tenant itself (it's an account-level object). This step is dashboard-only.

### 2. Log the CLI into the new tenant

```bash
auth0 login                      # opens a browser; pick the cobblecompanion tenant
auth0 tenants list               # confirm cobblecompanion.us.auth0.com is "active"
```

### 3. Create the Pulumi M2M app

```bash
auth0 apps create \
  --name "Pulumi-IaC" \
  --type m2m \
  --reveal-secrets \
  --description "M2M app used by Pulumi to manage the Auth0 tenant"
```

Copy the printed **Client ID** and **Client Secret** — you won't see the secret
again. (`--type m2m` == "Machine to Machine".)

### 4. Authorize the M2M app for the Management API

The app needs the Management API scopes that `auth0/src/m2m.ts` declares
(clients, client_grants, resource_servers, connections, users, actions). The
Management API's identifier is `https://<YOUR_DOMAIN>/api/v2/`.

```bash
DOMAIN=cobblecompanion.us.auth0.com
M2M_CLIENT_ID=<from step 3>

auth0 api post client-grants --data "$(cat <<JSON
{
  "client_id": "$M2M_CLIENT_ID",
  "audience": "https://$DOMAIN/api/v2/",
  "scope": [
    "read:clients","create:clients","update:clients","delete:clients",
    "read:client_grants","create:client_grants","update:client_grants","delete:client_grants",
    "read:resource_servers","create:resource_servers","update:resource_servers","delete:resource_servers",
    "read:connections","create:connections","update:connections","delete:connections",
    "read:users","create:users","update:users","delete:users",
    "read:actions","create:actions","update:actions","delete:actions"
  ]
}
JSON
)"
```

(Dashboard equivalent: **Applications → Pulumi-IaC → APIs → Auth0 Management
API → enable**, then tick those scopes.)

### 5. Get the client-grant id (needed for the Pulumi import)

```bash
auth0 api get client-grants \
  | jq -r '.[] | select(.client_id=="'"$M2M_CLIENT_ID"'") | .id'
```

Save this **grant id** alongside the client id/secret.

### 6. Confirm the Google social connection exists

Auth0 provisions a `google-oauth2` connection in every new tenant by default
(`auth0/src/connections.ts` just enables it on the SPA). Verify:

```bash
auth0 api get connections | jq -r '.[].name'   # expect "google-oauth2" in the list
```

If it's missing, create it in **Authentication → Social → Google** (the default
Auth0 dev credentials are fine for testing; swap in your own Google Cloud OAuth
client for production).

### You now have everything Pulumi needs

| Value | Used as | Where |
|---|---|---|
| Tenant domain | `auth0:domain` | `pulumi config set auth0:domain …` |
| M2M client id | `auth0:clientId` + the import target | `pulumi config set auth0:clientId …` / `pulumi import` |
| M2M client secret | `auth0:clientSecret` (encrypted) | `pulumi config set --secret auth0:clientSecret …` |
| M2M grant id | the import target for `pulumi-iac-grant` | `pulumi import` |

Continue with **[`auth0/README.md`](./auth0/README.md) Phase B** (init the stack,
set config, import the M2M app, `pulumi up`).

---

## Order of operations

1. **Auth0 manual bootstrap** (this file).
2. **`infra/auth0`** Pulumi — Phases B–D in `auth0/README.md`. Outputs
   `auth0Domain`, `spaClientId`, `apiAudience`.
3. **`infra/gcp`** Pulumi — `gcp/README.md`. Reads `spaClientId` from the auth0
   stack via a StackReference; deploys Cloud Run.
4. **Populate secrets** (`DATABASE_URL`, `OPENROUTER_API_KEY`) and
   **`make deploy-dev`** to push the image.
5. **Wire back** the `*.run.app` URL into the auth0 stack's `spaOrigins` and
   re-`pulumi up` so Universal Login can redirect to it.
