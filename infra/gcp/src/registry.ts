// Artifact Registry Docker repo for the single container image (api). One repo
// per project keeps image URLs short:
//   <region>-docker.pkg.dev/<project>/cobblecompanion/<service>:<tag>
//
// CI pushes to this repo (via `gcloud auth configure-docker`); Cloud Run pulls
// from it via the runtime service account that gets
// roles/artifactregistry.reader (see src/iam.ts).
import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import { enabledApis } from './apis';

const cfg = new pulumi.Config('gcp');
const region = cfg.get('region') ?? 'us-central1';

export const containerRepo = new gcp.artifactregistry.Repository(
  'cobblecompanion-containers',
  {
    repositoryId: 'cobblecompanion',
    location: region,
    format: 'DOCKER',
    description: 'CobbleCompanion service container images.',
  },
  { dependsOn: enabledApis },
);

// Convenience builder for "<region>-docker.pkg.dev/<project>/cobblecompanion/<service>:<tag>".
export function imageUri(
  project: pulumi.Input<string>,
  service: string,
  tag: pulumi.Input<string>,
): pulumi.Output<string> {
  return pulumi.interpolate`${region}-docker.pkg.dev/${project}/cobblecompanion/${service}:${tag}`;
}
