// The single EC2 t3.micro. It runs two containers on the host:
//   - cobble-app : the Fastify API + built SPA (one origin), published to
//                  127.0.0.1:3000 only — never exposed (the SG has no :3000).
//   - caddy      : terminates TLS (Let's Encrypt) on 80/443 and reverse-proxies
//                  to the app on loopback.
// Postgres is on Supabase; a systemd timer pings it every ~2 days so the free
// tier doesn't auto-pause. The external secrets (OpenRouter key, DB DSN) are
// fetched at boot from SSM via the instance profile, so no plaintext lives in
// user-data or Pulumi state. EXCEPTION: the single-tenant Discord secret + bot-
// token key are supplied inline (see the discord block below), so those two do
// live in user-data + Pulumi state — an accepted trade for a not-public surface.
//
// `userDataReplaceOnChange` means bumping the image tag (which changes user-data)
// replaces the instance — a clean, immutable redeploy. The Elastic IP is a
// separate resource so the public address survives the replacement.
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import { publicSubnet, webSg } from './network';
import { imageUri, registryHost } from './registry';
import { instanceProfile } from './iam';
import { parameters } from './secrets';
import { uploadsBucket, UPLOAD_PREFIX } from './storage';

const tags = { Project: 'cobblecompanion', ManagedBy: 'pulumi' };

const cfg = new pulumi.Config();
const region = new pulumi.Config('aws').require('region');
const instanceType = cfg.get('instanceType') ?? 't3.micro';
const imageTag = cfg.get('imageTag') ?? 'latest';
const googleClientId = cfg.require('googleClientId');
const llmModel = cfg.get('llmModel') ?? 'anthropic/claude-3.5-sonnet';
const domain = cfg.require('domain');
// The Discord surface is always-on (companion-discord.md §9). The client id is the
// public half of the worker's service credential; it defaults to a fixed value and
// the api auto-seeds the matching service_registry row at boot from
// SERVICE_REGISTRY_SEEDS (built below). The secret + bot-token key are single-tenant
// and supplied inline (like local docker's .env), not via SSM: each is taken from
// Pulumi config if set, else generated once and kept stable in Pulumi state (the
// token key must survive instance replacement so already-stored bot tokens stay
// decryptable). NOTE: this means those two values live in user-data + Pulumi state.
const discordServiceClientId = cfg.get('discordServiceClientId') ?? 'discord-adapter';
const discordServiceSecret =
  cfg.getSecret('discordServiceSecret') ??
  new random.RandomString('discord-service-secret', { length: 43, special: false }).result;
const discordTokenKey =
  cfg.getSecret('discordTokenKey') ??
  new random.RandomBytes('discord-token-key', { length: 32 }).base64;
// The seed the api consumes at boot to insert the worker's credential row (idempotent
// on the (client_id, secret) unique index). pulumi.jsonStringify resolves the secret
// Output into the JSON.
const discordServiceRegistrySeeds = pulumi.jsonStringify([
  { client_id: discordServiceClientId, secret: discordServiceSecret, label: 'discord' },
]);
// Optional ACME contact email. Caddy issues certs fine without one, but setting
// it opts into Let's Encrypt expiry/issue notifications. Emitted as a global
// Caddy options block only when configured.
const acmeEmail = cfg.get('letsencryptEmail');
const caddyGlobalBlock = acmeEmail ? `{\n    email ${acmeEmail}\n}\n` : '';

// Block-device name for the persistent Caddy data volume (Let's Encrypt certs +
// ACME account). On Nitro instances (t3) this is exposed as an NVMe device; the
// amazon-ec2-utils udev rules on Amazon Linux 2023 create a /dev/sdf symlink for
// it, which the bootstrap waits on and mounts.
const dataDevice = '/dev/sdf';

// Latest Amazon Linux 2023 x86_64 AMI (matches the t3.micro / linux-amd64 image).
const ami = aws.ec2.getAmiOutput({
  owners: ['amazon'],
  mostRecent: true,
  filters: [
    { name: 'name', values: ['al2023-ami-*-x86_64'] },
    { name: 'architecture', values: ['x86_64'] },
    { name: 'state', values: ['available'] },
  ],
});

// Boot-time secret fetch: one line per managed parameter, appended to
// /etc/cobble.env. Best-effort (`|| true`) so a not-yet-populated parameter
// doesn't abort the whole bootstrap — the box, Caddy, and SSM still come up.
// NOTE: the env file is snapshotted into the container at `docker run` time
// (`--env-file`), so secrets must be populated in SSM *before* first boot.
// Populating or changing a parameter afterwards does NOT propagate to the
// running app — trigger a redeploy (image-tag bump replaces the instance and
// re-runs this bootstrap) to pick up the new value.
const secretFetchScript = pulumi
  .all(parameters.map((p) => pulumi.interpolate`${p.envVar}\t${p.parameter.name}`))
  .apply((pairs) =>
    pairs
      .map((pair) => {
        const [envVar, paramName] = pair.split('\t');
        return [
          `V=$(aws ssm get-parameter --region "$REGION" --with-decryption \\`,
          `  --name "${paramName}" --query Parameter.Value --output text 2>/dev/null || true)`,
          `printf '%s=%s\\n' "${envVar}" "$V" >> /etc/cobble.env`,
        ].join('\n');
      })
      .join('\n'),
  );

// The Discord worker runs as a SECOND container from the SAME image, with the run
// command overridden to the worker entrypoint (companion-discord.md §2,
// plans/discord-surface.md D6). Host network so it reaches the api on the host's
// loopback :3000 (like Caddy). Always emitted — the surface is always-on and its
// env (DISCORD_*) is always present in /etc/cobble.env.
const discordWorkerBlock = `docker rm -f cobble-discord 2>/dev/null || true
docker run -d --restart=always --name cobble-discord --network host \\
  --env-file /etc/cobble.env "$IMAGE" \\
  pnpm --filter @cobble/discord run serve`;

const userData = pulumi.interpolate`#!/bin/bash
exec > >(tee /var/log/cobble-bootstrap.log) 2>&1
set -x

REGION="${region}"
IMAGE="${imageUri(imageTag)}"
REGISTRY="${registryHost}"
DOMAIN="${domain}"

# 1. 2 GB swap — backstop for PDF-ingestion memory spikes on a 1 GB box.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2. Packages: Docker (app + Caddy) and the psql client (keep-alive).
dnf install -y docker postgresql15
systemctl enable --now docker

# 3. Runtime env. Non-secret config first, then secrets from SSM Parameter Store.
umask 077
cat > /etc/cobble.env <<EOF
NODE_ENV=production
PORT=3000
LLM_PROVIDER=openrouter
LLM_MODEL=${llmModel}
GOOGLE_CLIENT_ID=${googleClientId}
UPLOAD_STAGING_BACKEND=s3
UPLOAD_STAGING_S3_BUCKET=${uploadsBucket.bucket}
UPLOAD_STAGING_S3_REGION=${region}
UPLOAD_STAGING_PREFIX=${UPLOAD_PREFIX}
DISCORD_SERVICE_CLIENT_ID=${discordServiceClientId}
DISCORD_SERVICE_SECRET=${discordServiceSecret}
DISCORD_TOKEN_KEY=${discordTokenKey}
SERVICE_REGISTRY_SEEDS=${discordServiceRegistrySeeds}
DISCORD_WS_BASE_URL=ws://127.0.0.1:3000
DISCORD_MINT_URL=http://127.0.0.1:3000/internal/discord/token
EOF
${secretFetchScript}

# 4. Pull the image from ECR and run the app on loopback only. Retry login+pull:
#    instance-profile credentials can take a few seconds to propagate at first
#    boot, and a transient pull failure would otherwise leave the app uncreated
#    (no container for --restart=always to revive).
for i in $(seq 1 10); do
  if aws ecr get-login-password --region "$REGION" \\
       | docker login --username AWS --password-stdin "$REGISTRY" \\
     && docker pull "$IMAGE"; then
    break
  fi
  echo "ECR login/pull attempt $i failed; retrying in 15s..."
  sleep 15
done
docker rm -f cobble-app 2>/dev/null || true
docker run -d --restart=always --name cobble-app \\
  -p 127.0.0.1:3000:3000 --env-file /etc/cobble.env "$IMAGE"

# 4b. The Discord worker (same image, worker command), if the surface is configured.
${discordWorkerBlock}

# 5. Persistent Caddy data volume. The instance is replaced on every redeploy
#    (userDataReplaceOnChange), so Let's Encrypt certs + the ACME account must
#    live on a separate EBS volume that survives replacement — otherwise every
#    deploy re-issues the cert and hits the Let's Encrypt duplicate-cert limit.
#    Wait for the attachment, format only if blank (never reformat — that would
#    wipe the certs), then mount.
for i in $(seq 1 30); do [ -e ${dataDevice} ] && break; sleep 2; done
if ! blkid ${dataDevice} >/dev/null 2>&1; then
  mkfs.ext4 -L caddydata ${dataDevice}
else
  # The volume can detach uncleanly when an instance is replaced (forceDetach),
  # leaving the ext4 journal dirty; replay/repair it before mounting so a dirty
  # filesystem can't silently fall back to an empty /data and re-issue the cert.
  fsck.ext4 -p ${dataDevice} || true
fi
mkdir -p /var/lib/caddy/data
grep -q '/var/lib/caddy/data' /etc/fstab \\
  || echo 'LABEL=caddydata /var/lib/caddy/data ext4 defaults,nofail 0 2' >> /etc/fstab
mount /var/lib/caddy/data

# 6. Caddy: automatic HTTPS + reverse proxy to the app. Host network so it binds
#    80/443 on the instance and can reach the app's loopback-published port.
#    /data (certs) is bind-mounted from the persistent volume; /config holds only
#    derived state, so a named volume is fine there.
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
${caddyGlobalBlock}$DOMAIN {
    reverse_proxy 127.0.0.1:3000
}
EOF
docker rm -f caddy 2>/dev/null || true
docker run -d --restart=always --name caddy --network host \\
  -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \\
  -v /var/lib/caddy/data:/data -v caddy_config:/config \\
  caddy:2

# 7. Supabase keep-alive: a oneshot timer runs SELECT 1 every ~2 days (well under
#    the 7-day free-tier pause window). EnvironmentFile loads DATABASE_URL without
#    shell interpretation, so DSN metacharacters (& ? =) are safe.
cat > /etc/systemd/system/supabase-keepalive.service <<'EOF'
[Unit]
Description=Supabase keep-alive (prevents free-tier auto-pause)
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
EnvironmentFile=/etc/cobble.env
ExecStart=/usr/bin/psql "\${DATABASE_URL}" -tAc "select 1"
EOF
cat > /etc/systemd/system/supabase-keepalive.timer <<EOF
[Unit]
Description=Run Supabase keep-alive every ~2 days
[Timer]
OnCalendar=*-*-1/2 03:17:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now supabase-keepalive.timer
`;

const instance = new aws.ec2.Instance(
  'cc-app',
  {
    ami: ami.id,
    instanceType,
    subnetId: publicSubnet.id,
    vpcSecurityGroupIds: [webSg.id],
    iamInstanceProfile: instanceProfile.name,
    rootBlockDevice: {
      volumeSize: 16,
      volumeType: 'gp3',
      deleteOnTermination: true,
      encrypted: true,
    },
    userData,
    // Redeploy = replace the instance so it re-runs bootstrap with the new image.
    userDataReplaceOnChange: true,
    tags: { ...tags, Name: 'cobblecompanion' },
  },
  // Tear the old instance down BEFORE creating the replacement. The single Caddy
  // data volume (below) can only be attached to one instance at a time, so the
  // default create-before-delete would boot the new instance while the volume is
  // still on the old one: the VolumeAttachment can't move, the bootstrap's wait
  // for /dev/sdf times out, and Caddy comes up with an empty /data and RE-ISSUES
  // the cert — the exact duplicate-cert-rate-limit failure the persistent volume
  // exists to prevent. Deleting first frees the volume (and the Elastic IP), so
  // the new instance attaches cleanly and re-mounts the existing certs. It also
  // means only one instance runs `db:migrate` at a time. The tradeoff is a brief
  // gap during redeploy, which a Phase-0 micro tolerates.
  { deleteBeforeReplace: true },
);

// Persistent EBS volume for Caddy's Let's Encrypt state. It is a standalone
// resource (not part of the instance's block-device mapping), so it survives the
// instance replacement that every redeploy triggers — keeping the issued certs
// and ACME account across deploys. Same AZ as the instance's subnet, encrypted.
const caddyDataVolume = new aws.ebs.Volume('cc-caddy-data', {
  availabilityZone: publicSubnet.availabilityZone,
  size: 2,
  type: 'gp3',
  encrypted: true,
  tags: { ...tags, Name: 'cobblecompanion-caddy-data' },
});

new aws.ec2.VolumeAttachment('cc-caddy-data-attach', {
  deviceName: dataDevice,
  volumeId: caddyDataVolume.id,
  instanceId: instance.id,
  // Let the volume detach cleanly when the instance is replaced on redeploy.
  forceDetach: true,
});

// Stable public address across instance replacement.
export const eip = new aws.ec2.Eip('cc-eip', { domain: 'vpc', tags });
new aws.ec2.EipAssociation('cc-eip-assoc', {
  instanceId: instance.id,
  allocationId: eip.allocationId,
});

export const publicIp = eip.publicIp;
export const appUrl = pulumi.interpolate`https://${domain}`;
