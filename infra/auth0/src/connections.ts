import * as auth0 from '@pulumi/auth0';

import { spa } from './spa';

// Look up the existing `google-oauth2` connection. Auth0 provisions this in
// every new tenant by default, wired to Auth0's shared dev OAuth credentials.
// For prod, replace those with your own Google Cloud OAuth client by setting
// `options.clientId` / `options.clientSecret` on this connection (out of scope
// here — bring the connection itself under Pulumi management at that point).
const googleConnection = auth0.getConnectionOutput({ name: 'google-oauth2' });

// Enable `google-oauth2` on the SPA. Managing the link (not the connection)
// keeps prod free to enable a different set of connections per stack.
export const spaGoogleConnection = new auth0.ConnectionClient('spa-google', {
  connectionId: googleConnection.id,
  clientId: spa.clientId,
});
