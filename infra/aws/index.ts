// CobbleCompanion AWS stack. One EC2 t3.micro runs the Fastify API + built SPA
// behind Caddy; Postgres is on Supabase (external). See
// docs/infra-setup.md (and infra/aws/README.md) for apply order + out-of-band steps
// (Supabase project, secret population, image push, DNS + OAuth origin).
//
// Side-effect imports compose the modules; the explicit re-exports surface the
// deploy outputs (`pulumi stack output`).
import { repo } from './src/registry';
import { publicIp, appUrl } from './src/compute';
import { uploadsBucket } from './src/storage';
import './src/secrets';
import './src/iam';

export const ecrRepoUrl = repo.repositoryUrl;
export const instancePublicIp = publicIp;
export const url = appUrl;
export const uploadsBucketName = uploadsBucket.bucket;
