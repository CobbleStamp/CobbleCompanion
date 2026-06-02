# infra/gcp — GCP infrastructure as code

This Pulumi project owns the **CobbleCompanion GCP project** configuration: one
Cloud Run service (`cc-api`, the Fastify API serving the built SPA), the
Artifact Registry Docker repo, the two Secret Manager entries, and the
per-service IAM binding. (Ported and trimmed from CobbleBrowse's `infra/gcp` —
no workers, no load balancer; the default `*.run.app` URL is used.)

## Decisions

| | |
|---|---|
| Language | TypeScript |
| State backend | AWS S3 (shared with `infra/auth0`) |
| Secret encryption | Passphrase (`PULUMI_CONFIG_PASSPHRASE`) |
| Stacks | `dev` only initially |
| Provider | `@pulumi/gcp` (pinned, no `^`) |
| Image registry | `<region>-docker.pkg.dev/<project>/cobblecompanion/<service>:<tag>` |
| DNS | None — the `*.run.app` URL is the entry point. |

---

## Phase A — One-time bootstrap (manual)

The GCP project (`cobblecompanion`), a billing link, and a Supabase project
must already exist — Pulumi can't create the project it deploys into.

```bash
gcloud auth login
gcloud config set project cobblecompanion
aws sts get-caller-identity                       # S3 state backend creds
gcloud auth configure-docker <region>-docker.pkg.dev
```

---

## Phase B — First apply

```bash
cd infra/gcp
cp Pulumi.dev.yaml.example Pulumi.dev.yaml
$EDITOR Pulumi.dev.yaml      # project, region, auth0Domain/Audience/Stack, llmModel

export PULUMI_CONFIG_PASSPHRASE='<reuse CobbleBrowse's>'
pulumi login s3://<shared-state-bucket>
pulumi stack init dev        # first time only
pulumi stack select dev

pnpm install --ignore-workspace
pulumi preview               # ~6 resources: SA, repo, 2 secrets, service, invoker
pulumi up
```

`pulumi stack output apiUrl` prints the Cloud Run URL.

---

## Phase C — Populate Secret Manager values

Pulumi creates the secret containers but never sees plaintext values. Once per
stack:

```bash
PROJECT=cobblecompanion

echo -n "postgresql://...@<host>.pooler.supabase.com:6543/postgres" \
  | gcloud secrets versions add DATABASE_URL --project=$PROJECT --data-file=-

echo -n "<OpenRouter API key>" \
  | gcloud secrets versions add OPENROUTER_API_KEY --project=$PROJECT --data-file=-
```

Cloud Run pulls the `latest` version on the next instance start.

---

## Phase D — Push the image + roll the service

From the repo root:

```bash
export GCP_PROJECT=cobblecompanion
export GCP_REGION=<region>                # must match Pulumi.dev.yaml
export PULUMI_CONFIG_PASSPHRASE=<...>

make deploy-dev                           # build + push + bump imageTag + pulumi up
```

`make deploy-dev` tags the image with `git rev-parse --short HEAD`, pushes it,
sets `cobblecompanion-gcp:imageTag`, and runs `pulumi up`. Pass `TAG=<sha>` to
skip the rebuild and just re-apply.

---

## Phase E — Wire the Cloud Run URL into Auth0

After the first deploy, add the `*.run.app` URL to the Auth0 SPA's allowed
origins/callbacks so Universal Login can redirect back:

```bash
APIURL=$(pulumi stack output apiUrl)
cd ../auth0
pulumi config set --path 'cobblecompanion-auth0:spaOrigins[2]' "$APIURL"
pulumi up
```

Smoke test:

```bash
curl -sS "$APIURL/health"               # → {"status":"ok"}
curl -sS "$APIURL/auth/config" | jq .   # → public Auth0 config
```

---

## Destroying the stack

```bash
pulumi destroy
```

Secret Manager secrets persist; `gcloud secrets delete <NAME>` cleans them up.
