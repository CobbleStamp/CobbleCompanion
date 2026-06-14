// The single EC2 t3.micro. It runs two containers on the host:
//   - cobble-app : the Fastify API + built SPA (one origin), published to
//                  127.0.0.1:3000 only — never exposed (the SG has no :3000).
//   - caddy      : terminates TLS (Let's Encrypt) on 80/443 and reverse-proxies
//                  to the app on loopback.
// Postgres is on Supabase; a systemd timer pings it every ~2 days so the free
// tier doesn't auto-pause. Secrets are fetched at boot via the instance profile,
// so no plaintext lives in user-data or Pulumi state.
//
// `userDataReplaceOnChange` means bumping the image tag (which changes user-data)
// replaces the instance — a clean, immutable redeploy. The Elastic IP is a
// separate resource so the public address survives the replacement.
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { publicSubnet, webSg } from './network';
import { imageUri, registryHost } from './registry';
import { instanceProfile } from './iam';
import { parameters } from './secrets';

const tags = { Project: 'cobblecompanion', ManagedBy: 'pulumi' };

const cfg = new pulumi.Config();
const region = new pulumi.Config('aws').require('region');
const instanceType = cfg.get('instanceType') ?? 't3.micro';
const imageTag = cfg.get('imageTag') ?? 'latest';
const googleClientId = cfg.require('googleClientId');
const llmModel = cfg.get('llmModel') ?? 'anthropic/claude-3.5-sonnet';
const domain = cfg.require('domain');

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
// doesn't abort the whole bootstrap — the box, Caddy, and SSM still come up; the
// app retries via `--restart=always` once the value is set.
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
EOF
${secretFetchScript}

# 4. Pull the image from ECR and run the app on loopback only.
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker pull "$IMAGE"
docker rm -f cobble-app 2>/dev/null || true
docker run -d --restart=always --name cobble-app \\
  -p 127.0.0.1:3000:3000 --env-file /etc/cobble.env "$IMAGE"

# 5. Caddy: automatic HTTPS + reverse proxy to the app. Host network so it binds
#    80/443 on the instance and can reach the app's loopback-published port.
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:3000
}
EOF
docker rm -f caddy 2>/dev/null || true
docker run -d --restart=always --name caddy --network host \\
  -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \\
  -v caddy_data:/data -v caddy_config:/config \\
  caddy:2

# 6. Supabase keep-alive: a oneshot timer runs SELECT 1 every ~2 days (well under
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

const instance = new aws.ec2.Instance('cc-app', {
  ami: ami.id,
  instanceType,
  subnetId: publicSubnet.id,
  vpcSecurityGroupIds: [webSg.id],
  iamInstanceProfile: instanceProfile.name,
  rootBlockDevice: { volumeSize: 16, volumeType: 'gp3', deleteOnTermination: true },
  userData,
  // Redeploy = replace the instance so it re-runs bootstrap with the new image.
  userDataReplaceOnChange: true,
  tags: { ...tags, Name: 'cobblecompanion' },
});

// Stable public address across instance replacement.
export const eip = new aws.ec2.Eip('cc-eip', { domain: 'vpc', tags });
new aws.ec2.EipAssociation('cc-eip-assoc', {
  instanceId: instance.id,
  allocationId: eip.allocationId,
});

export const publicIp = eip.publicIp;
export const appUrl = pulumi.interpolate`https://${domain}`;
