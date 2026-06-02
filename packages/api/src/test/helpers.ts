import { createTestDatabase } from '@cobble/db/testing';
import {
  DrizzleAuthTokenStore,
  DrizzleIdentityStore,
  FakeLlmGateway,
  Harness,
  TranscriptMemoryStore,
  type Logger,
} from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../app.js';
import type { AppConfig } from '../config.js';
import type { EmailSender } from '../email.js';

export const silentLogger: Logger = { error: () => {}, info: () => {} };

/** Email sender that records the last magic link instead of sending it. */
export class CapturingEmailSender implements EmailSender {
  lastLink: string | null = null;
  lastEmail: string | null = null;

  async sendMagicLink(email: string, link: string): Promise<void> {
    this.lastEmail = email;
    this.lastLink = link;
  }
}

export const testConfig: AppConfig = {
  databaseUrl: 'unused-in-tests',
  llmProvider: 'fake',
  openrouterApiKey: '',
  llmModel: 'test-model',
  sessionSecret: 'test-session-secret-at-least-32-chars-long',
  appUrl: 'http://localhost:5173',
  emailTransport: 'console',
  port: 0,
  isProduction: false,
};

export interface TestApp {
  readonly app: FastifyInstance;
  readonly deps: AppDeps;
  readonly email: CapturingEmailSender;
  readonly close: () => Promise<void>;
}

export async function makeTestApp(chunks: readonly string[] = ['Hi', ' there']): Promise<TestApp> {
  const { db, close: closeDb } = await createTestDatabase();
  const memory = new TranscriptMemoryStore(db);
  const email = new CapturingEmailSender();
  const deps: AppDeps = {
    identity: new DrizzleIdentityStore(db),
    authTokens: new DrizzleAuthTokenStore(db),
    memory,
    harness: new Harness({
      gateway: new FakeLlmGateway(chunks),
      memory,
      model: 'test-model',
      logger: silentLogger,
    }),
    email,
    config: testConfig,
    logger: silentLogger,
  };
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    email,
    close: async () => {
      await app.close();
      await closeDb();
    },
  };
}

/** Run the full magic-link flow and return the session cookie (`name=value`). */
export async function signIn(
  app: FastifyInstance,
  email: CapturingEmailSender,
  address: string,
): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/auth/request-link',
    payload: { email: address },
  });
  const token = new URL(email.lastLink ?? '').searchParams.get('token');
  const verified = await app.inject({
    method: 'GET',
    url: `/auth/verify?token=${token}`,
  });
  const header = verified.headers['set-cookie'];
  const cookie = Array.isArray(header) ? header[0] : header;
  return (cookie ?? '').split(';')[0] ?? '';
}
