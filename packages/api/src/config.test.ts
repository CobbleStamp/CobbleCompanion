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
    expect(config.ingestionQueueMax).toBe(100);
    expect(config.tokenCapPerDay).toBe(1_000_000);
  });

  it('overrides the queue + token-cap knobs from the environment', () => {
    const config = loadConfig({
      ...base,
      ...fakeProviders,
      INGESTION_QUEUE_MAX: '2',
      TOKEN_CAP_PER_DAY: '50000',
    });
    expect(config.ingestionQueueMax).toBe(2);
    expect(config.tokenCapPerDay).toBe(50000);
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

  it('rejects a non-localhost http LANGFUSE_HOST (must be https)', () => {
    expect(() =>
      loadConfig({ ...base, ...fakeProviders, LANGFUSE_HOST: 'http://traces.evil.example' }),
    ).toThrow();
  });

  it('accepts an https LANGFUSE_HOST and an http localhost host', () => {
    expect(
      loadConfig({ ...base, ...fakeProviders, LANGFUSE_HOST: 'https://cloud.langfuse.com' })
        .langfuseHost,
    ).toBe('https://cloud.langfuse.com');
    expect(
      loadConfig({ ...base, ...fakeProviders, LANGFUSE_HOST: 'http://localhost:3030' })
        .langfuseHost,
    ).toBe('http://localhost:3030');
  });

  it('requires both Langfuse keys when TRACING_PROVIDER=langfuse', () => {
    expect(() =>
      loadConfig({
        ...base,
        ...fakeProviders,
        TRACING_PROVIDER: 'langfuse',
        LANGFUSE_PUBLIC_KEY: 'pk',
      }),
    ).toThrow();
  });

  it('marks production from NODE_ENV', () => {
    const config = loadConfig({
      ...base,
      ...fakeProviders,
      NODE_ENV: 'production',
    });
    expect(config.isProduction).toBe(true);
  });

  describe('MCP_SERVERS', () => {
    it('defaults to no whitelisted servers (acquisition off)', () => {
      expect(loadConfig({ ...base, ...fakeProviders }).mcpServers).toEqual([]);
    });

    it('parses a valid array, carrying optional label + authTokenEnv through', () => {
      const config = loadConfig({
        ...base,
        ...fakeProviders,
        MCP_SERVERS: JSON.stringify([
          {
            ref: 'stocks',
            endpoint: 'https://mcp.example.com/mcp',
            label: 'Stocks',
            authTokenEnv: 'STOCKS_TOKEN',
          },
        ]),
      });
      expect(config.mcpServers).toEqual([
        {
          ref: 'stocks',
          endpoint: 'https://mcp.example.com/mcp',
          label: 'Stocks',
          authTokenEnv: 'STOCKS_TOKEN',
        },
      ]);
    });

    it('omits absent optional keys rather than setting them undefined', () => {
      const [server] = loadConfig({
        ...base,
        ...fakeProviders,
        MCP_SERVERS: JSON.stringify([{ ref: 'stocks', endpoint: 'https://mcp.example.com/mcp' }]),
      }).mcpServers;
      // exactOptionalPropertyTypes: the key must be absent, not present-and-undefined.
      expect(server && 'label' in server).toBe(false);
      expect(server && 'authTokenEnv' in server).toBe(false);
    });

    it('throws a clear error on malformed JSON', () => {
      expect(() => loadConfig({ ...base, ...fakeProviders, MCP_SERVERS: 'not json' })).toThrow(
        /MCP_SERVERS must be a JSON array/,
      );
    });

    it('rejects an entry missing the required endpoint', () => {
      expect(() =>
        loadConfig({ ...base, ...fakeProviders, MCP_SERVERS: JSON.stringify([{ ref: 'stocks' }]) }),
      ).toThrow();
    });

    it('rejects an entry whose endpoint is not a URL', () => {
      expect(() =>
        loadConfig({
          ...base,
          ...fakeProviders,
          MCP_SERVERS: JSON.stringify([{ ref: 'stocks', endpoint: 'not-a-url' }]),
        }),
      ).toThrow();
    });

    it('rejects a JSON object that is not an array', () => {
      expect(() =>
        loadConfig({
          ...base,
          ...fakeProviders,
          MCP_SERVERS: JSON.stringify({ ref: 'stocks', endpoint: 'https://mcp.example.com/mcp' }),
        }),
      ).toThrow();
    });
  });
});
