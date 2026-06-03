// CobbleCompanion GCP stack. See infra/gcp/README.md for apply order +
// out-of-band steps (secret population, container image push).
//
// Side-effect imports compose the modules; the explicit re-export below
// surfaces the Cloud Run URL.
import { api } from './src/cloudrun';
import { containerRepo } from './src/registry';
// Side-effect imports — declared resources don't need re-export.
import './src/secrets';
import './src/iam';

export const apiUrl = api.uri;
export const containerRepoId = containerRepo.repositoryId;
