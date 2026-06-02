import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/cobble',
  AUTH0_DOMAIN: 'tenant.us.auth0.com',
  AUTH0_CLIENT_ID: 'client-id',
  AUTH0_AUDIENCE: 'https://api.cobble.test',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({ ...base, LLM_PROVIDER: 'fake' });
    expect(config.llmProvider).toBe('fake');
    expect(config.port).toBe(3000);
    expect(config.appUrl).toBe('http://localhost:3001');
    expect(config.authMode).toBe('auth0');
    expect(config.isProduction).toBe(false);
  });

  it('requires the Auth0 settings when AUTH_MODE=auth0', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://localhost/cobble',
        LLM_PROVIDER: 'fake',
      }),
    ).toThrow();
  });

  it('allows missing Auth0 settings in dev_bypass mode', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/cobble',
      LLM_PROVIDER: 'fake',
      AUTH_MODE: 'dev_bypass',
    });
    expect(config.authMode).toBe('dev_bypass');
    expect(config.devBypassEmail).toBe('dev@cobble.local');
  });

  it('requires an OpenRouter key when provider is openrouter', () => {
    expect(() =>
      loadConfig({ ...base, LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: '' }),
    ).toThrow();
  });

  it('marks production from NODE_ENV', () => {
    const config = loadConfig({
      ...base,
      LLM_PROVIDER: 'fake',
      NODE_ENV: 'production',
    });
    expect(config.isProduction).toBe(true);
  });
});
