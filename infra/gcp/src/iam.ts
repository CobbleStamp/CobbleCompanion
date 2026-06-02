// Runtime IAM for the single Cloud Run service. The api runs as its own
// service account with the narrowest viable role set: read its two secrets,
// and pull its image from Artifact Registry.
import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import { enabledApis } from './apis';
import { secrets } from './secrets';
import { containerRepo } from './registry';

// Name matches the Cloud Run service ID in src/cloudrun.ts.
export const apiSa = new gcp.serviceaccount.Account(
  'sa-api',
  { accountId: 'cc-api', displayName: 'CobbleCompanion api Cloud Run runtime SA' },
  { dependsOn: enabledApis },
);

// -- Secret accessors. One IamMember per (secret, SA) pair. --------------
const grantSecret = (
  saEmail: pulumi.Output<string>,
  secret: gcp.secretmanager.Secret,
  tag: string,
) =>
  new gcp.secretmanager.SecretIamMember(`grant-${tag}`, {
    secretId: secret.id,
    role: 'roles/secretmanager.secretAccessor',
    member: pulumi.interpolate`serviceAccount:${saEmail}`,
  });

grantSecret(apiSa.email, secrets.DATABASE_URL, 'api-db-url');
grantSecret(apiSa.email, secrets.OPENROUTER_API_KEY, 'api-openrouter-key');

// -- Artifact Registry pull access. ------------------------------------
new gcp.artifactregistry.RepositoryIamMember('grant-pull-api', {
  repository: containerRepo.name,
  location: containerRepo.location,
  role: 'roles/artifactregistry.reader',
  member: pulumi.interpolate`serviceAccount:${apiSa.email}`,
});
