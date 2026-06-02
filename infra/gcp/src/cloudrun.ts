// The single Cloud Run service: the Fastify API, which also serves the built
// React SPA from the same origin (@fastify/static). One URL for both the app
// and the REST API — no CORS, no second service.
//
// minInstances=1 keeps the API warm (architecture.md §8: the hot path must
// avoid cold starts). Secrets are mounted via SecretManagerEnvVar so the
// runtime reads them as ordinary env vars. The SPA client_id is sourced from
// the sibling infra/auth0 stack so there is a single source of truth.
import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import { enabledApis } from './apis';
import { containerRepo, imageUri } from './registry';
import { secrets } from './secrets';
import { apiSa } from './iam';

const gcpCfg = new pulumi.Config('gcp');
const cfg = new pulumi.Config();
const project = gcpCfg.require('project');
const region = gcpCfg.get('region') ?? 'us-central1';
const tag = cfg.get('imageTag') ?? 'latest';

const auth0Domain = cfg.require('auth0Domain');
const auth0Audience = cfg.require('auth0Audience');
// SPA client_id served to the React app via /auth/config. Sourced from the
// sibling infra/auth0 stack (the SPA app is owned there as
// auth0.Client cobblecompanion-web). Set `cobblecompanion-gcp:auth0Stack` to
// the fully-qualified slug, e.g. `organization/cobblecompanion-auth0/dev`.
const auth0StackName = cfg.require('auth0Stack');
const auth0Stack = new pulumi.StackReference(auth0StackName);
const auth0ClientId = auth0Stack.requireOutput('spaClientId') as pulumi.Output<string>;

// LLM model is non-sensitive runtime config; the provider key lives in Secret
// Manager as OPENROUTER_API_KEY.
const llmModel = cfg.get('llmModel') ?? 'anthropic/claude-3.5-sonnet';

// Helper: build a SecretManagerEnvVar reference (latest version).
function secretEnv(
  name: string,
  secret: gcp.secretmanager.Secret,
): pulumi.Input<gcp.types.input.cloudrunv2.ServiceTemplateContainerEnv> {
  return {
    name,
    valueSource: {
      secretKeyRef: { secret: secret.secretId, version: 'latest' },
    },
  };
}

export const api = new gcp.cloudrunv2.Service(
  'cc-api',
  {
    name: 'cc-api',
    location: region,
    ingress: 'INGRESS_TRAFFIC_ALL',
    // Service-level scaling default — declare it explicitly so Pulumi's desired
    // state matches what the API returns (avoids perpetual ~scaling drift).
    scaling: { minInstanceCount: 1 },
    template: {
      serviceAccount: apiSa.email,
      // Keep one instance warm; cap modestly for a Phase 0 single-tenant app.
      scaling: { minInstanceCount: 1, maxInstanceCount: 5 },
      maxInstanceRequestConcurrency: 80,
      // SSE chat streams hold a connection open; allow up to Cloud Run's cap.
      timeout: '3600s',
      containers: [
        {
          image: imageUri(project, 'api', tag),
          // PORT is reserved by Cloud Run — it auto-injects PORT=8080 to match
          // ports.containerPort; the Fastify app reads PORT (config.ts).
          ports: { containerPort: 8080 },
          resources: { limits: { cpu: '1', memory: '512Mi' } },
          envs: [
            { name: 'NODE_ENV', value: 'production' },
            { name: 'AUTH_MODE', value: 'auth0' },
            { name: 'AUTH0_DOMAIN', value: auth0Domain },
            { name: 'AUTH0_AUDIENCE', value: auth0Audience },
            { name: 'AUTH0_CLIENT_ID', value: auth0ClientId },
            { name: 'LLM_PROVIDER', value: 'openrouter' },
            { name: 'LLM_MODEL', value: llmModel },
            secretEnv('DATABASE_URL', secrets.DATABASE_URL),
            secretEnv('OPENROUTER_API_KEY', secrets.OPENROUTER_API_KEY),
          ],
        },
      ],
    },
  },
  { dependsOn: [containerRepo, ...enabledApis] },
);

// Public invoker — anyone can hit it; the Auth0 middleware enforces auth at
// the app layer (bearer-token JWT validation in the Fastify API).
new gcp.cloudrunv2.ServiceIamMember('api-public-invoker', {
  name: api.name,
  location: api.location,
  role: 'roles/run.invoker',
  member: 'allUsers',
});
