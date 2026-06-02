import * as auth0 from '@pulumi/auth0';
import * as pulumi from '@pulumi/pulumi';

// The Pulumi M2M app is the chicken-and-egg credential: Pulumi needs it to
// authenticate to Auth0 in order to manage anything else. It is therefore
// created manually once (see infra/auth0/README.md Phase A4), and then
// brought under Pulumi management via `pulumi import` so future scope or
// metadata changes are versioned.

const cfg = new pulumi.Config('auth0');
const domain = cfg.require('domain');
const m2mClientId = cfg.require('clientId');

export const pulumiM2M = new auth0.Client(
  'pulumi-iac',
  {
    name: 'Pulumi-IaC',
    appType: 'non_interactive',
    grantTypes: ['client_credentials'],
  },
  { import: m2mClientId },
);

// The grant ID is discovered via `auth0 api get client-grants` and passed to
// `pulumi import` (see README.md Phase C).
export const pulumiM2MGrant = new auth0.ClientGrant('pulumi-iac-grant', {
  clientId: pulumiM2M.clientId,
  audience: `https://${domain}/api/v2/`,
  scopes: [
    'read:clients',
    'create:clients',
    'update:clients',
    'delete:clients',
    'read:client_grants',
    'create:client_grants',
    'update:client_grants',
    'delete:client_grants',
    'read:resource_servers',
    'create:resource_servers',
    'update:resource_servers',
    'delete:resource_servers',
    'read:connections',
    'create:connections',
    'update:connections',
    'delete:connections',
    'read:users',
    'create:users',
    'update:users',
    'delete:users',
    // Actions + trigger bindings (post-login allowlist gate, src/allowlist.ts).
    'read:actions',
    'create:actions',
    'update:actions',
    'delete:actions',
  ],
});
