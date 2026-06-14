# infra — Pulumi infrastructure

Pulumi (TypeScript) projects provision what CobbleCompanion needs to run in the
cloud and govern its repository:

| Project | Owns | README |
|---|---|---|
| [`aws/`](./aws/README.md) | **Deploy option (canonical):** EC2 `t3.micro` (Fastify API + built SPA via Caddy), ECR, SSM Parameter Store secrets, VPC/IAM (Postgres is on Supabase, external) | `aws/README.md` |
| [`gcp/`](./gcp/README.md) | **Deploy option (alternative):** one Cloud Run service (Fastify API + built SPA), Artifact Registry, Secret Manager, IAM (Postgres is on Supabase, external) | `gcp/README.md` |
| [`github/`](./github/README.md) | GitHub branch protection on `main` (merge blocked until the CI `verify` check passes) | `github/README.md` |

All projects use an AWS S3 state backend and a `PULUMI_CONFIG_PASSPHRASE`.

> **Deployment is one of two clouds — pick one**, `aws` (an EC2 micro running the
> API + SPA behind Caddy) or `gcp` (a Cloud Run service); both put Postgres on
> Supabase and run the same container image. The deployment diagrams, resource
> catalogs, and cost are in [`../docs/infra-setup.md`](../docs/infra-setup.md);
> apply order and out-of-band steps are in [`aws/README.md`](./aws/README.md) and
> [`gcp/README.md`](./gcp/README.md).

**Almost everything is managed as code.** The exceptions are the credentials and
accounts Pulumi authenticates *with* (they must exist before Pulumi runs), a
registered domain / DNS record for the public URL, plus the Google OAuth client
used for "Sign in with Google", which the Cloud Console won't expose via API for
a consumer (External) app.

Auth is **per-request**: Google Sign-In (browser, Google as the OIDC provider —
the SPA gets a Google ID token and the API verifies it against Google's JWKS) and
service-token auth (backends) coexist on one server. There is no third-party auth
service and no auth Pulumi stack.

---

## Per-project env isolation with direnv (recommended)

[direnv](https://direnv.net) scopes environment variables to a directory: it
loads a repo's `.envrc` on `cd` **in** and **unloads it on the way out**, so one
project's values can't bleed into another. This repo ships a ready
`.envrc.example`.

One-time machine setup (you run these — installing tools and editing your shell
profile is outside what the repo does for you):

```bash
brew install direnv
echo 'command -v direnv >/dev/null && eval "$(direnv hook zsh)"' >> ~/.zshrc
```

Then, in this repo:

```bash
cp .envrc.example .envrc        # .envrc is gitignored
direnv allow
```

`PULUMI_CONFIG_PASSPHRASE` + AWS credentials (for the S3 state backend) stay
global in your shell profile — they're shared across stacks. The per-cloud deploy
vars are project-scoped in `.envrc`: `AWS_REGION` for the AWS option, or
`GCP_PROJECT` / `GCP_REGION` for the GCP option (override CobbleBrowse's globals
so the deploy doesn't push to the wrong project).

---

## Google OAuth client (one-time, ~10 min, Console-only)

This step can't be done by CLI/Pulumi: for a consumer "Sign in with Google" app,
the OAuth consent screen + Web client are Cloud Console-only on a standalone
project.

1. **APIs & Services → OAuth consent screen** → User type **External** → fill in
   the app name, support email, developer email → scopes `openid`, `email`,
   `profile` → add yourself under **Test users** (or Publish later).
2. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   type **Web application** → **Authorized JavaScript origins**:
   `http://localhost:3001` and (after the first deploy) the production URL
   (`https://companion.<domain>`). Redirect URIs are not needed for the Google
   Identity Services ID-token flow. → **Create** → copy the **Client ID**.
3. Provide `GOOGLE_CLIENT_ID` to the app:
   - local: `.env`,
   - cloud: Pulumi config on whichever deploy stack you use —
     `cobblecompanion-aws:googleClientId` or `cobblecompanion-gcp:googleClientId`.

   It's public (it ships to the browser), so there is **no secret entry** for it.

> **Chicken-and-egg:** the production origin isn't known until the first deploy
> (the `*.run.app` URL on GCP, or where DNS points on AWS). Add it to the OAuth
> client's Authorized JavaScript origins afterward. Origins are exact (no
> wildcards) and per-environment.
