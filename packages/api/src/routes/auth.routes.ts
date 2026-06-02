import { requestMagicLinkSchema } from '@cobble/shared';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { clearSession, readSession, setSession } from '../session.js';

const TOKEN_TTL_MS = 15 * 60 * 1000;

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { identity, authTokens, email, config, logger } = deps;

  // Request a magic link. Always responds 200 — never reveal whether the email exists.
  app.post('/auth/request-link', async (request, reply) => {
    const parsed = requestMagicLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'a valid email is required' });
    }
    const { email: address } = parsed.data;
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    try {
      await authTokens.createToken(address, token, expiresAt);
      const link = `${request.protocol}://${request.host}/auth/verify?token=${token}`;
      await email.sendMagicLink(address, link);
    } catch (error) {
      logger.error('failed to issue magic link', {
        operation: 'auth.request-link',
        error,
      });
      return reply.code(500).send({ error: 'could not issue a sign-in link' });
    }
    return reply.send({ ok: true });
  });

  // Verify a magic link: consume the token, ensure the user, set the session, redirect.
  app.get('/auth/verify', async (request, reply) => {
    const token = (request.query as { token?: string }).token;
    if (!token) {
      return reply.redirect(`${config.appUrl}/?error=invalid_link`);
    }
    try {
      const address = await authTokens.consumeToken(token, new Date());
      if (!address) {
        return reply.redirect(`${config.appUrl}/?error=invalid_link`);
      }
      const user = await identity.ensureUserByEmail(address);
      setSession(reply, user.id, config.isProduction);
      return reply.redirect(`${config.appUrl}/`);
    } catch (error) {
      logger.error('failed to verify magic link', {
        operation: 'auth.verify',
        error,
      });
      return reply.redirect(`${config.appUrl}/?error=verify_failed`);
    }
  });

  app.post('/auth/logout', async (_request, reply) => {
    clearSession(reply);
    return reply.send({ ok: true });
  });

  app.get('/auth/me', async (request, reply) => {
    const userId = readSession(request);
    if (!userId) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    const user = await identity.getUserById(userId);
    if (!user) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    return reply.send({ user: { id: user.id, email: user.email } });
  });
}
