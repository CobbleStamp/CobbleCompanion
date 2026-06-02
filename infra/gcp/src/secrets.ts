// Secret Manager entries. Pulumi creates the secret resources (the
// "containers"); the values are populated out of band so plaintext secrets
// never live in the IaC code or in Pulumi state.
//
// One-time per stack, after `pulumi up`:
//
//   echo -n "<value>" | gcloud secrets versions add SECRET_NAME \
//       --project=<project> --data-file=-
//
// The Cloud Run service in src/cloudrun.ts mounts these as env vars via
// SecretManagerEnvVar — the runtime reads them like any other env var.
import * as gcp from '@pulumi/gcp';
import { enabledApis } from './apis';

interface SecretSpec {
  id: string;
  description: string;
}

const specs: readonly SecretSpec[] = [
  {
    id: 'DATABASE_URL',
    description: 'Supabase PgBouncer DSN (port 6543, transaction mode). Consumed by the api.',
  },
  {
    id: 'OPENROUTER_API_KEY',
    description: 'OpenRouter LLM gateway API key. Consumed by the api.',
  },
];

export const secrets = Object.fromEntries(
  specs.map((s) => [
    s.id,
    new gcp.secretmanager.Secret(
      `secret-${s.id.toLowerCase()}`,
      {
        secretId: s.id,
        replication: { auto: {} },
        labels: { managed_by: 'pulumi', description_short: shortLabel(s.description) },
      },
      { dependsOn: enabledApis },
    ),
  ]),
) as Record<(typeof specs)[number]['id'], gcp.secretmanager.Secret>;

// GCP labels reject most punctuation + cap at 63 chars.
function shortLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .slice(0, 63);
}
