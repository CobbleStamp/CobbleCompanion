import * as pulumi from '@pulumi/pulumi';

import { spa } from './src/spa';
import { api } from './src/api';
// Side-effect import: brings the bootstrap M2M app + its client grant under
// Pulumi management. See src/m2m.ts.
import './src/m2m';
// Side-effect import: enables Google SSO on the SPA. See src/connections.ts.
import './src/connections';
// Side-effect import: post-login email allowlist gate. See src/allowlist.ts.
import './src/allowlist';

const cfg = new pulumi.Config('auth0');

export const auth0Domain = cfg.require('domain');
export const spaClientId = spa.clientId;
export const apiAudience = api.identifier;
// No spaClientSecret export: the SPA uses PKCE (appType "spa", no client
// secret). The Fastify API validates tokens against Auth0's JWKS endpoint.
