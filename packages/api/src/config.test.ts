import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/cobble',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
};

/** Both LLM and embedding access offline — no provider key needed. */
const fakeProviders = {
  LLM_PROVIDER: 'fake',
  EMBEDDING_PROVIDER: 'fake',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({ ...base, ...fakeProviders });
    expect(config.llmProvider).toBe('fake');
    expect(config.port).toBe(3000);
    expect(config.appUrl).toBe('http://localhost:3001');
    expect(config.authMode).toBe('google');
    expect(config.isProduction).toBe(false);
    expect(config.embeddingModel).toBe('perplexity/pplx-embed-v1-0.6b');
    expect(config.embeddingDimensions).toBe(1024);
    expect(config.useContextHeader).toBe(true);
    expect(config.ingestionMaxBytes).toBeGreaterThan(0);
  });

  it('requires GOOGLE_CLIENT_ID when AUTH_MODE=google', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://localhost/cobble',
        ...fakeProviders,
      }),
    ).toThrow();
  });

  it('allows a missing GOOGLE_CLIENT_ID in dev_bypass mode', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/cobble',
      ...fakeProviders,
      AUTH_MODE: 'dev_bypass',
    });
    expect(config.authMode).toBe('dev_bypass');
    expect(config.devBypassEmail).toBe('dev@cobble.local');
  });

  it('requires an OpenRouter key when the LLM provider is openrouter', () => {
    expect(() =>
      loadConfig({
        ...base,
        LLM_PROVIDER: 'openrouter',
        EMBEDDING_PROVIDER: 'fake',
        OPENROUTER_API_KEY: '',
      }),
    ).toThrow();
  });

  it('requires an OpenRouter key when the embedding provider is openrouter', () => {
    expect(() =>
      loadConfig({
        ...base,
        LLM_PROVIDER: 'fake',
        EMBEDDING_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: '',
      }),
    ).toThrow();
  });

  it('parses the context-header A/B knob', () => {
    const config = loadConfig({ ...base, ...fakeProviders, USE_CONTEXT_HEADER: 'false' });
    expect(config.useContextHeader).toBe(false);
  });

  it('marks production from NODE_ENV', () => {
    const config = loadConfig({
      ...base,
      ...fakeProviders,
      NODE_ENV: 'production',
    });
    expect(config.isProduction).toBe(true);
  });
});
