import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'cobble_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Set the signed session cookie identifying the logged-in user. */
export function setSession(reply: FastifyReply, userId: string, isProduction: boolean): void {
  reply.setCookie(SESSION_COOKIE, userId, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Read and verify the session cookie; returns the userId or null. */
export function readSession(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const result = request.unsignCookie(raw);
  return result.valid && result.value ? result.value : null;
}
