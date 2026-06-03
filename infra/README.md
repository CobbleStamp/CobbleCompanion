# infra — Pulumi infrastructure

Pulumi (TypeScript) projects provision everything CobbleCompanion needs to run
in the cloud and govern its repository:

| Project | Owns | README |
|---|---|---|
| [`gcp/`](./gcp/README.md) | One Cloud Run service (Fastify API + built SPA), Artifact Registry, Secret Manager, IAM | `gcp/README.md` |
| [`github/`](./github/README.md) | GitHub branch protection on `main` (merge blocked until the CI `verify` check passes) | `github/README.md` |

It uses an AWS S3 state backend and a `PULUMI_CONFIG_PASSPHRASE`.

**Almost everything is managed as code.** The exceptions are the credentials and
accounts Pulumi authenticates *with* (they must exist before Pulumi runs) plus
the Google OAuth client used for "Sign in with Google", which the Cloud Console
won't expose via API for a consumer (External) app:

- **GCP:** the project + billing link (see `gcp/README.md` Phase A).
- **Google OAuth client:** the consent screen + Web client ID (below).

Auth is **Google Sign-In directly** (Google as the OIDC provider): the SPA gets
a Google ID token and the API verifies it against Google's JWKS. There is no
third-party auth service, no tenant, and no second Pulumi stack.

---

## Reusing your existing CobbleBrowse setup (`~/.zshrc`)

If you already deploy CobbleBrowse, your shell exports
`PULUMI_CONFIG_PASSPHRASE`, `GCP_REGION`, and `GCP_PROJECT`. Some of that is
reusable, some is **CobbleBrowse-specific and must be overridden** — getting
this wrong points CobbleCompanion's deploy at CobbleBrowse's GCP project.

| `~/.zshrc` export | Reuse? | Why |
|---|---|---|
| `PULUMI_CONFIG_PASSPHRASE` | ✅ reuse | Just the passphrase that encrypts stack secrets — shared across stacks in the same S3 backend. |
| AWS creds / `pulumi login s3://…` | ✅ reuse | Same state bucket; CobbleCompanion uses different stack names (`cobblecompanion-*`). |
| `gcloud` auth | ✅ reuse | Same Google account. Just switch the active GCP project. |
| `GCP_REGION=europe-west2` | ✅ reuse | A region choice — fine to keep. Must match `gcp:region` in `gcp/Pulumi.dev.yaml`. |
| `GCP_PROJECT=cobblebrowse` | ❌ **override** → `cobblecompanion` | The `Makefile` reads `GCP_PROJECT`; left as-is it pushes the image to CobbleBrowse's Artifact Registry. |

### Per-project isolation with direnv (recommended)

[direnv](https://direnv.net) scopes environment variables to a directory: it
loads a repo's `.envrc` on `cd` **in** and **unloads it on the way out**, so one
project's values can't bleed into another. This repo ships a ready
`.envrc.example`.

One-time machine setup (you run these — installing tools and editing your shell
profile is outside what the repo does for you):

```bash
brew install direnv
# hook direnv into zsh, then restart your shell:
echo 'command -v direnv >/dev/null && eval "$(direnv hook zsh)"' >> ~/.zshrc
```

Then, in this repo:

```bash
cp .envrc.example .envrc        # .envrc is gitignored
direnv allow
```

CobbleCompanion's `.envrc` (see [`../.envrc.example`](../.envrc.example)) exports
`GCP_PROJECT=cobblecompanion` + `GCP_REGION=europe-west2` and loads the repo's
`.env`. So **inside this directory the CobbleBrowse globals are gone** and both
the deploy and the app use CobbleCompanion's own values — even if `~/.zshrc`
still exports CobbleBrowse's.

---

## Google OAuth client (one-time, ~10 min, Console-only)

This step can't be done by gcloud/Pulumi: for a consumer "Sign in with Google"
app, the OAuth consent screen + Web client are Cloud Console-only on a
standalone project (the gcloud OAuth commands are IAP-brand/-client, which
require an org and produce clients unusable for SPA sign-in). It's the same
class of one-time bootstrap as creating the GCP project + billing.

In project **`cobblecompanion`** (<https://console.cloud.google.com>):

1. **APIs & Services → OAuth consent screen** → User type **External** → fill in
   the app name, your support email, and developer email → scopes `openid`,
   `email`, `profile` → add yourself under **Test users** (or Publish later for
   broader access).
2. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   type **Web application** → **Authorized JavaScript origins**:
   `http://localhost:3001` and (after the first deploy) the `*.run.app` URL.
   Redirect URIs are not needed for the Google Identity Services ID-token button
   flow. → **Create** → copy the **Client ID**.
3. Provide `GOOGLE_CLIENT_ID` to the app:
   - local: `.env` (and `.envrc` via `dotenv`),
   - cloud: `pulumi config set cobblecompanion-gcp:googleClientId <id>`.

   It's public (it ships to the browser), so there is **no Secret Manager
   entry** for it.

> **Chicken-and-egg:** the `*.run.app` origin isn't known until the first
> deploy. Add it to the OAuth client's Authorized JavaScript origins after
> deploying. Origins are exact (no wildcards) and per-environment — every URL
> that serves the SPA must be listed.

> **Consent screen "testing" mode** caps at 100 users and shows an "unverified
> app" notice until published/verified — fine for personal use as a test user.

---

## Order of operations

0. **Isolate env per project** — set up direnv + `.envrc` (see above) so
   CobbleBrowse's globals don't leak into this repo's Pulumi/Make commands.
1. **GCP prerequisites** (`gcp/README.md` Phase A: `gcloud auth login`, project +
   billing, `gcloud auth configure-docker`) + **Google OAuth client** (above).
2. **`infra/gcp`** Pulumi — `gcp/README.md`. Set `cobblecompanion-gcp:googleClientId`
   from the OAuth client; creates the Cloud Run service + secret containers.
3. **Populate secrets** (`DATABASE_URL`, `OPENROUTER_API_KEY` via
   `gcloud secrets versions add`) and **`make deploy-dev`** to push the image.
4. **Wire back** the `*.run.app` URL into the OAuth client's Authorized
   JavaScript origins so Google Sign-In works from the deployed SPA.
