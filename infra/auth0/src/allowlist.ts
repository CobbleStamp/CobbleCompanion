import * as auth0 from '@pulumi/auth0';
import * as pulumi from '@pulumi/pulumi';

const cfg = new pulumi.Config();

// Per-stack email allowlist. Emails are not secrets, so this is plaintext
// config (mirrors `spaOrigins` in src/spa.ts). Set with:
//   pulumi config set --path 'allowedEmails[0]' alice@example.com
// (no `auth0:` prefix — that namespace is reserved for the @pulumi/auth0
// provider's own settings). Switch to `--secret` later if desired; the
// action JS works either way.
const allowedEmails = (cfg.getObject<string[]>('allowedEmails') ?? []).map((e) =>
  e.trim().toLowerCase(),
);

// Inject the allowlist as data, not code. `JSON.stringify` guarantees the
// output is a valid JS array literal — emails cannot contain JSON-special
// characters that would break out of the literal.
const allowedEmailsJson = JSON.stringify(allowedEmails);

const actionCode = `/**
 * Post-login allowlist gate.
 *
 * Denies sign-in for any identity whose email is not in the per-stack
 * allowlist. Managed entirely by Pulumi — edit via
 *   pulumi config set --path 'allowedEmails[N]' <email>
 * then \`pulumi up\`. Do not edit in the Auth0 dashboard; changes will be
 * reverted on the next deploy.
 *
 * Also sets the \`email\` custom claim on the access token — the Fastify API
 * reads it to JIT-provision the user (packages/api/src/auth-guard.ts).
 */
exports.onExecutePostLogin = async (event, api) => {
  const allowed = ${allowedEmailsJson};
  const email = (event.user && event.user.email ? event.user.email : "").toLowerCase();
  const verified = event.user && event.user.email_verified === true;
  const strategy = event.connection && event.connection.strategy;
  if (strategy !== "google-oauth2" || !verified || !allowed.includes(email)) {
    api.access.deny("Email not on allowlist.");
  }
  api.accessToken.setCustomClaim("email", event.user.email);
};
`;

export const loginAllowlistAction = new auth0.Action('login-allowlist', {
  name: 'Login Allowlist',
  runtime: 'node22',
  deploy: true,
  code: actionCode,
  supportedTriggers: {
    id: 'post-login',
    version: 'v3',
  },
});

// `TriggerActions` (plural) manages the entire binding list for the
// `post-login` trigger. Using it (rather than `TriggerAction`, singular)
// prevents drift from manual dashboard edits.
export const postLoginFlow = new auth0.TriggerActions('post-login-flow', {
  trigger: 'post-login',
  actions: [
    {
      id: loginAllowlistAction.id,
      displayName: loginAllowlistAction.name,
    },
  ],
});
