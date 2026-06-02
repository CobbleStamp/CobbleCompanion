import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/cobble',
  AUTH_SESSION_SECRET: 'x'.repeat(40),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({ ...base, LLM_PROVIDER: 'fake' });
    expect(config.llmProvider).toBe('fake');
    expect(config.port).toBe(3000);
    expect(config.appUrl).toBe('http://localhost:5173');
    expect(config.isProduction).toBe(false);
  });

  it('requires a session secret of at least 32 chars', () => {
    expect(() =>
      loadConfig({ ...base, AUTH_SESSION_SECRET: 'short', LLM_PROVIDER: 'fake' }),
    ).toThrow();
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
