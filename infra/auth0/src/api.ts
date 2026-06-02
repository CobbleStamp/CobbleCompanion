import * as auth0 from '@pulumi/auth0';
import * as pulumi from '@pulumi/pulumi';

const cfg = new pulumi.Config();

const audience = cfg.get('apiAudience') ?? 'https://api.cobblecompanion.local';

export const api = new auth0.ResourceServer('cobblecompanion-api', {
  name: 'CobbleCompanion API',
  identifier: audience,
  signingAlg: 'RS256',
  // 24 hours.
  tokenLifetime: 86400,
  // Required for the SPA to obtain refresh tokens (offline_access scope).
  // Without this, /oauth/token omits refresh_token and the Auth0 SDK falls
  // back to iframe silent-auth, which fails under modern third-party-cookie
  // restrictions and forces a re-login when the access token expires.
  allowOfflineAccess: true,
  skipConsentForVerifiableFirstPartyClients: true,
  enforcePolicies: true,
});
