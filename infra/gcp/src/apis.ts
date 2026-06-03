// Required GCP service APIs. Pulumi blocks on these being enabled before
// creating any dependent resource (Cloud Run service, secret, etc.) — listing
// them here is enough; downstream resources depend on the matching export via
// `dependsOn`.
//
// Why each:
//   run.googleapis.com            — the Cloud Run service
//   artifactregistry              — Docker repo for the container image
//   secretmanager.googleapis.com  — DATABASE_URL + OPENROUTER_API_KEY
//   iam.googleapis.com            — the per-service runtime service account
//   iamcredentials.googleapis.com — token minting for the SA
import * as gcp from '@pulumi/gcp';

const services = [
  'run.googleapis.com',
  'artifactregistry.googleapis.com',
  'secretmanager.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
] as const;

export const enabledApis = services.map(
  (s) =>
    new gcp.projects.Service(`api-${s.split('.')[0]}`, {
      service: s,
      disableDependentServices: false,
      disableOnDestroy: false,
    }),
);
