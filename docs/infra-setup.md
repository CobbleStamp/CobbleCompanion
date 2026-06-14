# Infrastructure & Deployment

CobbleCompanion deploys to **one of two clouds — pick one per environment**. Both
run the *same* container (Fastify API + built React SPA on one origin) against the
*same* external **Supabase** Postgres; they differ only in how the box is hosted
and how secrets/TLS are wired. All infrastructure is managed as code with Pulumi
under `infra/`.

| Option | Shape | IaC | Apply runbook |
|---|---|---|---|
| **AWS EC2 `t3.micro`** (canonical) | one always-on box runs the container behind **Caddy** (TLS) | `infra/aws` | [`infra/aws/README.md`](../infra/aws/README.md) |
| **GCP Cloud Run** (alternative) | the container runs as a serverless service, TLS + URL managed by Google | `infra/gcp` | [`infra/gcp/README.md`](../infra/gcp/README.md) |

This doc is the canonical map of both — the diagrams, the resources, and the cost.
For the step-by-step apply runbooks (commands, apply order, out-of-band steps) see
the per-cloud READMEs above.

> Deployment trust model → `docs/architecture.md` §8. Auth model → §5 there.

## Shared building blocks

These are identical regardless of cloud.

### Container image

One image, built from the Dockerfile **`server` target**: the full source is
compiled, the SPA is built with `vite build` (empty `VITE_API_URL` → it calls its
own origin), and the API serves that bundle. The image is built `linux/amd64`,
tagged with the git short SHA, and pushed to the cloud's registry (ECR on AWS,
Artifact Registry on GCP) — **never built on the AWS micro** (the Vite build can
exceed 1 GB). On start the container runs `db:migrate` (which also enables the
`vector` extension) before serving. The host supplies `PORT`: Cloud Run injects
`8080`; the AWS box runs it on `3000` behind Caddy.

### Database — Supabase

Postgres is a **Supabase** managed project with `pgvector`, external to both
clouds. The app connects over the **pooled (PgBouncer) DSN on port `6543`,
transaction mode**; that DSN is the `DATABASE_URL` secret. Migrations run on
container start, so a deploy migrates Supabase automatically.

Free-tier Supabase projects **pause after 7 days of inactivity**, and a real query
resets the timer. How each cloud keeps it awake differs (below): the AWS box runs
a systemd keep-alive timer; Cloud Run has no always-on shell, so it relies on
traffic, an external scheduler, or **Supabase Pro** ($25/mo, never pauses + daily
backups — the upgrade path if a pause ever causes an outage).

---

## Option A — AWS EC2 micro (canonical)

### Topology

```
                    Internet
                       │  443 / 80
              ┌────────▼─────────┐   public subnet (IGW, no NAT)
              │  EC2 t3.micro    │   Amazon Linux 2023, 16 GB gp3, Elastic IP
              │  ┌────────────┐  │
              │  │ caddy :443 │  │  container, host network — TLS (Let's Encrypt)
              │  └─────┬──────┘  │
              │  ┌─────▼──────┐  │
              │  │ cobble-app │  │  container, 127.0.0.1:3000 — Fastify API + SPA
              │  └────────────┘  │  image pulled from ECR
              │  keep-alive timer│  systemd: SELECT 1 → Supabase, every ~2 days
              └────────┬─────────┘
                       │ TLS, pooled DSN (:6543) — over the public internet
              ┌────────▼─────────┐   external (not in AWS)
              │ Supabase Postgres│   managed, pgvector
              └──────────────────┘

  ECR ─────────────────── image pulled by the EC2 instance profile
  SSM Parameter Store ─── OPENROUTER_API_KEY, DATABASE_URL (fetched at boot)
  SSM Session Manager ─── shell access (no SSH, no open port 22)
```

**Why this shape.** One Node process serves both the API and the SPA, so "API +
web" is one container, not two services. LLM and embedding calls go out to
OpenRouter, so the box is an I/O-bound orchestrator + TLS terminator needing no
GPU. Postgres is off-box on Supabase, so the AWS side needs no in-VPC database —
and therefore no private subnets, DB subnet group, DB security group, or NAT
gateway.

### AWS resources (`infra/aws`)

| Module | Resources |
|---|---|
| `src/network.ts` | VPC `10.0.0.0/16`; one public subnet (first AZ, auto-assign public IP); Internet Gateway + route table; `cc-web` security group — inbound `80`/`443` from anywhere, all egress, **no SSH** |
| `src/registry.ts` | ECR repo `cobblecompanion` (scan-on-push) + lifecycle policy (expire untagged after 1 day; keep the 10 most recent) |
| `src/secrets.ts` | SSM Parameter Store `SecureString` params `/cobblecompanion/OPENROUTER_API_KEY` + `/cobblecompanion/DATABASE_URL` (free Standard tier, AWS-managed KMS key), each with a `REPLACE_ME` placeholder (`ignoreChanges` on the value, so out-of-band values are never reverted) |
| `src/iam.ts` | EC2 IAM role + instance profile: `AmazonSSMManagedInstanceCore` (Session Manager), scoped ECR pull, `ssm:GetParameter(s)` on exactly the two params + `kms:Decrypt` scoped to SSM (`ViaService`) |
| `src/compute.ts` | `t3.micro` (Amazon Linux 2023, 16 GB gp3 encrypted root); separate 2 GB encrypted gp3 data volume for Caddy's Let's Encrypt state (survives instance replacement so certs aren't re-issued every deploy); Elastic IP + association; `user-data` bootstrap (below); `userDataReplaceOnChange` so a new image tag replaces the instance |

Stack outputs (`pulumi stack output`): `ecrRepoUrl`, `instancePublicIp`, `url`.

**Not managed by Pulumi (out of band):** the AWS account/credentials, the
Supabase project, the DNS A record, and the Google OAuth Web client — see
`infra/aws/README.md` Phase A and `infra/README.md`.

### Instance bootstrap (`user-data`)

On first boot (and on every redeploy, since the instance is replaced), the
instance:

1. creates a **2 GB swapfile** — a backstop for PDF-ingestion memory spikes
   (`unpdf` in `@cobble/core`) on a 1 GB box;
2. installs Docker and the `psql` client;
3. writes `/etc/cobble.env` — non-secret config (`NODE_ENV`, `PORT=3000`,
   `LLM_PROVIDER`, `LLM_MODEL`, `GOOGLE_CLIENT_ID`) plus `OPENROUTER_API_KEY` and
   `DATABASE_URL` **fetched from SSM Parameter Store via the instance profile**
   (`aws ssm get-parameter --with-decryption`; no plaintext in user-data or state);
4. logs in to ECR, pulls the image, and runs `cobble-app` published to
   `127.0.0.1:3000` only (never exposed — the SG has no `:3000`);
5. mounts the **persistent Caddy data volume** at `/var/lib/caddy/data`
   (formatted only if blank, so existing certs are never wiped) — this EBS volume
   is separate from the instance and survives the redeploy replacement, so certs
   are kept instead of re-issued every deploy;
6. runs **Caddy** (`caddy:2`, host network) with a `Caddyfile` that reverse-proxies
   the domain to `127.0.0.1:3000` and obtains/renews a Let's Encrypt cert, with
   `/data` bind-mounted from the persistent volume above;
7. installs the **Supabase keep-alive** systemd timer (`OnCalendar` every ~2 days,
   `Persistent=true` to catch a missed tick after a reboot) that runs `SELECT 1`
   against the DSN. It loads `DATABASE_URL` via systemd `EnvironmentFile` (literal
   `KEY=VALUE`, no shell parsing) so DSN metacharacters (`& ? =`) are safe.

Bootstrap log on the box (via SSM Session Manager): `/var/log/cobble-bootstrap.log`.

### Deploying (AWS)

`make deploy-dev` from the repo root (see `infra/aws/README.md` for prerequisites
and the first-apply sequence):

1. build the `server` image (`linux/amd64`) and push it to ECR tagged with the
   git short SHA;
2. set `cobblecompanion-aws:imageTag` and run `pulumi up`;
3. because the tag is baked into `user-data` and the instance has
   `userDataReplaceOnChange`, Pulumi **replaces the instance**, which
   re-bootstraps and pulls the new image (a Phase-0 micro tolerates the brief
   downtime). `make deploy-dev TAG=<sha>` re-applies a tag without rebuilding.

### Cost (AWS)

| Component | Spec | ~Monthly |
|---|---|---|
| EC2 `t3.micro` | on-demand, 24/7 | ~$8 |
| Public IPv4 (Elastic IP) | 1 address × $0.005/hr | ~$3.65 |
| EBS root | 16 GB gp3 | ~$1.30 |
| EBS Caddy data | 2 GB gp3 (persistent cert store) | ~$0.16 |
| ECR storage | ~3 GB of images (free 500 MB/mo for the first year) | ~$0.30 |
| Secrets (SSM Parameter Store, SecureString Standard) | 2 params | $0 |
| Data transfer | low (personal) | ~$0–2 |
| Supabase | Free tier (with keep-alive) | $0 |
| **Total** | | **~$13–15/mo** |

Notes: every public IPv4 is billed since Feb 2024, so the Elastic IP costs even
while attached (free for the first 12 months on a new account). Secrets use SSM
Parameter Store Standard with the free AWS-managed `aws/ssm` KMS key — $0 (vs
~$0.80/mo on Secrets Manager); we trade away built-in rotation, which this
deployment doesn't use.

---

## Option B — GCP Cloud Run (alternative)

### Topology

```
                    Internet
                       │  HTTPS (managed cert, *.run.app)
              ┌────────▼──────────┐   fully managed, no VPC to run
              │  Cloud Run        │   service cc-api, region <region>
              │  ┌─────────────┐  │   minInstances=1 (hot path stays warm)
              │  │  cobble-app │  │   1 vCPU / 512 MiB, container port 8080
              │  └─────────────┘  │   image pulled from Artifact Registry
              └────────┬──────────┘   secrets mounted from Secret Manager
                       │ TLS, pooled DSN (:6543)
              ┌────────▼─────────┐   external (not in GCP)
              │ Supabase Postgres│   managed, pgvector
              └──────────────────┘

  Artifact Registry ──── image pulled by the runtime service account
  Secret Manager ─────── OPENROUTER_API_KEY, DATABASE_URL (mounted as env vars)
```

**Why this shape.** Cloud Run terminates TLS and hands out the `*.run.app` URL, so
there's no Caddy, no Elastic IP, no VPC, and no instance to bootstrap — Google runs
the box. `minInstances=1` keeps one instance warm so the first chat message after
idle isn't a cold start; `maxInstanceRequestConcurrency=80` and a long request
timeout (`3600s`) let one instance hold many concurrent SSE chat streams. The
public invoker is `allUsers` — the API still enforces auth at the app layer.

### GCP resources (`infra/gcp`)

| Module | Resources |
|---|---|
| `src/apis.ts` | Enables the required service APIs (`run`, `artifactregistry`, `secretmanager`, `iam`, `iamcredentials`); everything else `dependsOn` these |
| `src/registry.ts` | Artifact Registry Docker repo `cobblecompanion` + `imageUri()` helper (`<region>-docker.pkg.dev/<project>/cobblecompanion/api:<tag>`) |
| `src/secrets.ts` | Secret Manager containers `DATABASE_URL` + `OPENROUTER_API_KEY` (values populated out of band; plaintext never in IaC or state) |
| `src/iam.ts` | Runtime service account `cc-api`: `secretmanager.secretAccessor` on the two secrets + `artifactregistry.reader` on the repo |
| `src/cloudrun.ts` | The `cc-api` Cloud Run service (`minInstances=1`, `maxInstances=5`, 1 vCPU / 512 MiB, secrets as `SecretManagerEnvVar`) + public-invoker IAM binding |

Stack outputs (`pulumi stack output`): `apiUrl`, `containerRepoId`.

**Not managed by Pulumi (out of band):** the GCP project + billing link, the
Supabase project, and the Google OAuth Web client — see `infra/gcp/README.md`
Phase A and `infra/README.md`.

### Deploying (GCP)

`make deploy-gcp` from the repo root (see `infra/gcp/README.md` for prerequisites
and the first-apply sequence):

1. build the `server` image (`linux/amd64`) and push it to Artifact Registry
   tagged with the git short SHA;
2. set `cobblecompanion-gcp:imageTag` and run `pulumi up`;
3. Cloud Run rolls a new revision and shifts traffic to it (no downtime).
   `make deploy-gcp TAG=<sha>` re-applies a tag without rebuilding.

Secrets are populated once per stack with `gcloud secrets versions add` (Phase C);
the URL is the `*.run.app` output, wired into the OAuth client's authorized
origins after the first deploy.

**Keep-alive caveat.** Cloud Run has no always-on shell to run a `SELECT 1` timer,
and a warm `minInstances=1` instance does **not** query the DB on its own. If the
service sees no traffic for 7 days, Supabase can still pause. Options: rely on real
traffic, add a **Cloud Scheduler** job hitting a lightweight DB-touching endpoint
every ~2 days, or move to **Supabase Pro** (never pauses).

### Cost (GCP)

| Component | Spec | ~Monthly |
|---|---|---|
| Cloud Run | `minInstances=1`, 1 vCPU / 512 MiB, mostly idle | ~$10–18 |
| Artifact Registry storage | ~3 GB of images | ~$0.30 |
| Secret Manager | 2 active secret versions + low access | ~$0.12 |
| Egress | low (personal) | ~$0–2 |
| Supabase | Free tier | $0 |
| **Total** | | **~$11–20/mo** |

Notes: the dominant cost is the always-allocated `minInstances=1` instance — drop
it to `minInstances=0` to scale to ~$0 at idle if you can tolerate cold starts on
the first message. The Cloud Run free tier (vCPU-/GiB-seconds, 2M requests/mo)
offsets the request-driven portion; the always-on instance mostly exceeds it.

---

## Beyond the PoC

- **Edge rate-limiting (AWS).** The stock `caddy:2` image doesn't bundle the
  `rate_limit` module (it needs a custom `xcaddy` build). Cost-bearing endpoints
  are auth-gated meanwhile; add `@fastify/rate-limit` in-app or a custom Caddy
  image when abuse is a concern. (On Cloud Run, use Cloud Armor / per-service
  concurrency caps instead.)
- **CI image push.** Image build + push is currently a local `make deploy-dev` /
  `make deploy-gcp`; move it into CI.
- **Zero-downtime deploys (AWS).** Today an AWS deploy replaces the instance. If
  uptime matters, switch to in-place re-pull (an SSM `RunCommand`) or two instances
  behind a load balancer. (Cloud Run already does revision-based zero-downtime
  rollouts.)
- **Managed backups / HA.** Free-tier Supabase has limited backup retention and the
  single AWS micro is a single point of failure — both acceptable for a personal
  box; revisit with Supabase Pro (+ a second instance on AWS) if needed.
