# infra/aws — AWS infrastructure as code

This Pulumi project provisions CobbleCompanion's deployment: one **EC2
`t3.micro`** running the Fastify API + built SPA (one origin) behind **Caddy**
(TLS), an **ECR** repo for the image, **SSM Parameter Store** secrets, and a minimal
**VPC / IAM**. Postgres is on **Supabase** (external — not managed here). The
deployment diagram, resource catalog, and runtime layout are in
[`docs/infra-setup.md`](../../docs/infra-setup.md); this README is the apply runbook.

> This is the **canonical** of two deploy options. The alternative is **GCP Cloud
> Run** ([`../gcp/README.md`](../gcp/README.md)) — same container, same Supabase
> Postgres. Pick one per environment; they don't run together.

## Decisions

| | |
|---|---|
| Language | TypeScript |
| State backend | AWS S3 |
| Secret encryption | Passphrase (`PULUMI_CONFIG_PASSPHRASE`) |
| Stacks | `dev` only initially |
| Provider | `@pulumi/aws` (pinned, no `^`) |
| Database | Supabase (external; `DATABASE_URL` secret) |
| Admin access | SSM Session Manager (no SSH, no open port 22) |

## Modules

| File | Owns |
|---|---|
| `src/network.ts` | VPC, one public subnet, IGW, route table, `cc-web` security group |
| `src/registry.ts` | ECR repo + lifecycle policy + `imageUri`/`registryHost` helpers |
| `src/secrets.ts` | SSM Parameter Store `SecureString` params `OPENROUTER_API_KEY` + `DATABASE_URL` (placeholder value, set out of band; free Standard tier) |
| `src/iam.ts` | EC2 instance role + profile (ECR pull; `ssm:GetParameter(s)` + scoped `kms:Decrypt`; SSM Session Manager) |
| `src/compute.ts` | EC2 instance (encrypted root), persistent encrypted EBS volume for Caddy certs (survives redeploy), EIP, `user-data` (swap, Docker app + Caddy, keep-alive timer) |

---

## Phase A — One-time bootstrap (manual)

These exist before Pulumi runs:

1. AWS account + credentials (also the S3 state backend) — `aws sts get-caller-identity`.
2. A **Supabase project** — copy its pooled DSN (Project → Settings → Database →
   Connection pooling, port **6543**, transaction mode).
3. A **domain / DNS** you control for `companion.<domain>`.
4. The **Google OAuth Web client** (Console-only) — see [`../README.md`](../README.md).

---

## Phase B — First apply

```bash
cd infra/aws
cp Pulumi.dev.yaml.example Pulumi.dev.yaml
$EDITOR Pulumi.dev.yaml          # aws:region, googleClientId, domain, llmModel, [letsencryptEmail]

export PULUMI_CONFIG_PASSPHRASE='<shared backend passphrase>'
pulumi login s3://<shared-state-bucket>
pulumi stack init dev            # first time only
pulumi stack select dev

pnpm install --ignore-workspace
pulumi preview                   # VPC, subnet, SG, ECR, 2 secrets, IAM, EC2, EIP
pulumi up
```

`pulumi stack output` prints `ecrRepoUrl`, `instancePublicIp`, and `url`.

---

## Phase C — Populate secrets + point DNS

Pulumi creates the SSM parameters with a `REPLACE_ME` placeholder; set the real
values once per stack (they are never reverted by `pulumi up`):

```bash
aws ssm put-parameter --type SecureString --overwrite \
  --name /cobblecompanion/OPENROUTER_API_KEY --value '<OpenRouter API key>'
aws ssm put-parameter --type SecureString --overwrite \
  --name /cobblecompanion/DATABASE_URL --value '<Supabase pooled DSN, port 6543>'
```

Point a DNS **A record** for `companion.<domain>` at `instancePublicIp` (the
Elastic IP) so Caddy can obtain a Let's Encrypt cert.

---

## Phase D — Push the image + roll the instance

From the repo root:

```bash
export AWS_REGION=<region>                 # must match aws:region
export PULUMI_CONFIG_PASSPHRASE=<...>
make deploy-dev                            # build + push to ECR, bump imageTag, pulumi up
```

`make deploy-dev` builds the Dockerfile `server` target (`linux/amd64`), pushes
it to ECR tagged with the git short SHA, sets `cobblecompanion-aws:imageTag`, and
runs `pulumi up`. Because the tag is baked into `user-data` and the instance has
`userDataReplaceOnChange`, this **replaces the instance**, which re-bootstraps and
pulls the new image. Pass `TAG=<sha>` to skip the rebuild and just re-apply.

Caddy's Let's Encrypt state lives on a separate EBS volume that is *not* replaced,
so certs are re-attached (not re-issued) across redeploys — this is what keeps
frequent deploys from hitting Let's Encrypt's duplicate-cert rate limit. The
instance is set to `deleteBeforeReplace`, so the old box (and its volume
attachment) is torn down before the replacement boots; otherwise the new box would
start while the single cert volume is still attached to the old one, fail to mount
it, and re-issue the cert anyway. Note that
a redeploy snapshots the SSM secrets into the container at boot, so a secret
changed in SSM only takes effect on the next redeploy.

---

## Phase E — Wire the URL into the OAuth client

Add `https://companion.<domain>` to the Google OAuth client's **Authorized
JavaScript origins** (Cloud Console → APIs & Services → Credentials) so Google
Sign-In works from the deployed SPA. Origins are exact (no wildcards).

Smoke test:

```bash
URL=$(pulumi stack output url)
curl -sS "$URL/health"                     # → {"status":"ok"}
curl -sS "$URL/auth/config" | jq .         # → { "google_client_id": "..." }
```

Bootstrap logs on the box (via SSM Session Manager): `/var/log/cobble-bootstrap.log`.

---

## Destroying the stack

```bash
pulumi destroy
```

Supabase is external and unaffected. The SSM parameters are deleted with the stack.
