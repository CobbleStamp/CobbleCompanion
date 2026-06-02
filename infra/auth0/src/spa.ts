import * as auth0 from '@pulumi/auth0';
import * as pulumi from '@pulumi/pulumi';

const cfg = new pulumi.Config();

// Origins, callbacks, and logout URLs. Defaults match the local dev SPA.
// Override per-stack with: pulumi config set --path 'spaOrigins[0]' https://app.example.com
// After the first Cloud Run deploy, add the *.run.app URL here and re-apply.
const origins = cfg.getObject<string[]>('spaOrigins') ?? [
  'http://localhost:5173',
  'http://localhost:3001',
];

export const spa = new auth0.Client('cobblecompanion-web', {
  name: 'CobbleCompanion Web',
  appType: 'spa',
  callbacks: origins,
  allowedLogoutUrls: origins,
  webOrigins: origins,
  oidcConformant: true,
  grantTypes: ['authorization_code', 'refresh_token'],
  jwtConfiguration: {
    alg: 'RS256',
  },
  refreshToken: {
    rotationType: 'rotating',
    expirationType: 'expiring',
    // Absolute lifetime: 10 days. Auth0 requires idleTokenLifetime <
    // tokenLifetime — idle set to 7 days.
    tokenLifetime: 864000,
    idleTokenLifetime: 604800,
    leeway: 0,
    infiniteTokenLifetime: false,
    infiniteIdleTokenLifetime: false,
  },
});
