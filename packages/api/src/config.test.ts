import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, pathsOverlap } from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/cobble',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  // Required: the API signs its own session tokens (>=32 bytes).
  JWT_SIGNING_SECRET: 'test-jwt-signing-secret-at-least-32-bytes!!',
  // Default staging backend is `file`, which requires a root (see superRefine).
  UPLOAD_STAGING_FS_ROOT: '/tmp/cc-staging',
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
    expect(config.isProduction).toBe(false);
    expect(config.embeddingModel).toBe('perplexity/pplx-embed-v1-0.6b');
    expect(config.embeddingDimensions).toBe(1024);
    expect(config.useContextHeader).toBe(true);
    expect(config.ingestionMaxBytes).toBeGreaterThan(0);
    expect(config.ingestionQueueMax).toBe(100);
    expect(config.startingVitalityTokens).toBe(1_000_000);
    expect(config.wsMaxInFlight).toBe(32);
    expect(config.wsMaxBufferedBytes).toBe(8 * 1024 * 1024);
  });

  it('overrides the WS outbound-backpressure ceiling from the environment', () => {
    const config = loadConfig({ ...base, ...fakeProviders, WS_MAX_BUFFERED_BYTES: '1048576' });
    expect(config.wsMaxBufferedBytes).toBe(1_048_576);
  });

  it('rejects a non-positive WS_MAX_BUFFERED_BYTES', () => {
    expect(() => loadConfig({ ...base, ...fakeProviders, WS_MAX_BUFFERED_BYTES: '0' })).toThrow();
  });

  it('overrides the queue + starting-vitality knobs from the environment', () => {
    const config = loadConfig({
      ...base,
      ...fakeProviders,
      INGESTION_QUEUE_MAX: '2',
      STARTING_VITALITY_TOKENS: '50000',
    });
    expect(config.ingestionQueueMax).toBe(2);
    expect(config.startingVitalityTokens).toBe(50000);
  });

  it('requires GOOGLE_CLIENT_ID (Google is the browser scheme)', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://localhost/cobble',
        ...fakeProviders,
      }),
    ).toThrow(/GOOGLE_CLIENT_ID is required/);
  });

  it('requires a JWT_SIGNING_SECRET of at least 32 bytes', () => {
    const { JWT_SIGNING_SECRET: _omit, ...withoutSecret } = base;
    expect(() => loadConfig({ ...withoutSecret, ...fakeProviders })).toThrow(
      /JWT_SIGNING_SECRET is required and must be at least 32 bytes/,
    );
    expect(() =>
      loadConfig({ ...base, ...fakeProviders, JWT_SIGNING_SECRET: 'too-short' }),
    ).toThrow(/JWT_SIGNING_SECRET is required and must be at least 32 bytes/);
  });

  it('parses the session-token TTLs (defaults + overrides)', () => {
    const defaults = loadConfig({ ...base, ...fakeProviders });
    expect(defaults.accessTokenTtlSec).toBe(15 * 60);
    expect(defaults.refreshTokenTtlSec).toBe(24 * 60 * 60);
    const overridden = loadConfig({
      ...base,
      ...fakeProviders,
      ACCESS_TOKEN_TTL_SEC: '300',
      REFRESH_TOKEN_TTL_SEC: '3600',
    });
    expect(overridden.accessTokenTtlSec).toBe(300);
    expect(overridden.refreshTokenTtlSec).toBe(3600);
  });

  it('runs in production with Google + service-token auth', () => {
    const config = loadConfig({ ...base, ...fakeProviders, NODE_ENV: 'production' });
    expect(config.isProduction).toBe(true);
    expect(config.googleClientId).toBe('test-google-client-id');
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

  describe('UPLOAD_STAGING', () => {
    it('defaults to the file backend with the standard prefix + TTL', () => {
      const config = loadConfig({ ...base, ...fakeProviders });
      expect(config.uploadStaging).toEqual({
        backend: 'file',
        prefix: 'tmp-uploads',
        ttlMs: 60 * 60 * 1000,
        root: '/tmp/cc-staging',
        publicBaseUrl: 'http://localhost:3000',
      });
    });

    it('requires a filesystem root when the backend is file', () => {
      expect(() =>
        loadConfig({
          DATABASE_URL: 'postgres://localhost/cobble',
          GOOGLE_CLIENT_ID: 'test-google-client-id',
          ...fakeProviders,
          UPLOAD_STAGING_BACKEND: 'file',
        }),
      ).toThrow(/UPLOAD_STAGING_FS_ROOT is required/);
    });

    it('requires a bucket when the backend is s3', () => {
      expect(() =>
        loadConfig({
          ...base,
          ...fakeProviders,
          UPLOAD_STAGING_BACKEND: 's3',
          UPLOAD_STAGING_S3_REGION: 'us-east-1',
        }),
      ).toThrow(/UPLOAD_STAGING_S3_BUCKET is required/);
    });

    it('rejects a TTL beyond the 1-day bucket lifecycle cap', () => {
      expect(() =>
        loadConfig({
          ...base,
          ...fakeProviders,
          UPLOAD_STAGING_TTL_MS: String(24 * 60 * 60 * 1000 + 1),
        }),
      ).toThrow();
    });

    it('rejects a prefix containing a traversal segment', () => {
      expect(() =>
        loadConfig({
          ...base,
          ...fakeProviders,
          UPLOAD_STAGING_PREFIX: '../../etc',
        }),
      ).toThrow(/UPLOAD_STAGING_PREFIX/);
    });

    it('rejects a leading-slash (absolute) prefix', () => {
      expect(() =>
        loadConfig({
          ...base,
          ...fakeProviders,
          UPLOAD_STAGING_PREFIX: '/abs/uploads',
        }),
      ).toThrow(/UPLOAD_STAGING_PREFIX/);
    });

    it('accepts a nested slash-separated prefix', () => {
      const config = loadConfig({
        ...base,
        ...fakeProviders,
        UPLOAD_STAGING_PREFIX: 'tmp/uploads-v2',
      });
      expect(config.uploadStaging.prefix).toBe('tmp/uploads-v2');
    });

    it('builds the s3 backend from bucket + region', () => {
      const config = loadConfig({
        ...base,
        ...fakeProviders,
        UPLOAD_STAGING_BACKEND: 's3',
        UPLOAD_STAGING_S3_BUCKET: 'cc-uploads',
        UPLOAD_STAGING_S3_REGION: 'eu-west-1',
        UPLOAD_STAGING_PREFIX: 'tmp-uploads',
      });
      expect(config.uploadStaging).toEqual({
        backend: 's3',
        prefix: 'tmp-uploads',
        ttlMs: 60 * 60 * 1000,
        bucket: 'cc-uploads',
        region: 'eu-west-1',
      });
    });
  });

  describe('CLI_TOOLS_PATH / CLI_SCRATCH_DIR overlap', () => {
    it('accepts a tools dir disjoint from an explicit scratch dir', () => {
      const config = loadConfig({
        ...base,
        ...fakeProviders,
        CLI_TOOLS_PATH: '/opt/cli-tools',
        CLI_SCRATCH_DIR: '/var/cli-scratch',
      });
      expect(config.cliToolsPath).toBe('/opt/cli-tools');
      expect(config.cliScratchDir).toBe('/var/cli-scratch');
    });

    it('rejects a scratch dir nested inside the tools dir', () => {
      expect(() =>
        loadConfig({
          ...base,
          ...fakeProviders,
          CLI_TOOLS_PATH: '/opt/cli-tools',
          CLI_SCRATCH_DIR: '/opt/cli-tools/scratch',
        }),
      ).toThrow(/CLI_TOOLS_PATH must not overlap/);
    });

    it('rejects a tools dir equal to the scratch dir', () => {
      expect(() =>
        loadConfig({
          ...base,
          ...fakeProviders,
          CLI_TOOLS_PATH: '/srv/cli',
          CLI_SCRATCH_DIR: '/srv/cli',
        }),
      ).toThrow(/CLI_TOOLS_PATH must not overlap/);
    });

    it('rejects a tools dir under the default scratch (OS temp) when scratch is unset', () => {
      expect(() =>
        loadConfig({
          ...base,
          ...fakeProviders,
          CLI_TOOLS_PATH: join(tmpdir(), 'cli-tools'),
        }),
      ).toThrow(/CLI_TOOLS_PATH must not overlap/);
    });

    it('leaves the check off when CLI_TOOLS_PATH is empty (CLI track disabled)', () => {
      const config = loadConfig({ ...base, ...fakeProviders });
      expect(config.cliToolsPath).toBe('');
    });
  });

  describe('pathsOverlap', () => {
    it('detects equality, nesting (both directions), and disjoint paths', () => {
      expect(pathsOverlap('/a/b', '/a/b')).toBe(true);
      expect(pathsOverlap('/a', '/a/b')).toBe(true);
      expect(pathsOverlap('/a/b', '/a')).toBe(true);
      expect(pathsOverlap('/a/b', '/a/c')).toBe(false);
      // A shared name prefix is not nesting: /a/bc is not inside /a/b.
      expect(pathsOverlap('/a/b', '/a/bc')).toBe(false);
    });
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

  describe('SERVICE_REGISTRY_SEEDS', () => {
    it('defaults to no seeds', () => {
      expect(loadConfig({ ...base, ...fakeProviders }).serviceRegistrySeeds).toEqual([]);
    });

    it('parses a valid array, normalizing snake_case keys and carrying optionals through', () => {
      const config = loadConfig({
        ...base,
        ...fakeProviders,
        SERVICE_REGISTRY_SEEDS: JSON.stringify([
          { client_id: 'sprout', secret: 's3cret', secret_type: 'sha256', label: 'seed' },
        ]),
      });
      expect(config.serviceRegistrySeeds).toEqual([
        { clientId: 'sprout', secret: 's3cret', secretType: 'sha256', label: 'seed' },
      ]);
    });

    it('omits absent optional keys rather than setting them undefined', () => {
      const [seed] = loadConfig({
        ...base,
        ...fakeProviders,
        SERVICE_REGISTRY_SEEDS: JSON.stringify([{ client_id: 'sprout', secret: 's3cret' }]),
      }).serviceRegistrySeeds;
      expect(seed && 'secretType' in seed).toBe(false);
      expect(seed && 'label' in seed).toBe(false);
    });

    it('throws a clear error on malformed JSON', () => {
      expect(() =>
        loadConfig({ ...base, ...fakeProviders, SERVICE_REGISTRY_SEEDS: 'not json' }),
      ).toThrow(/SERVICE_REGISTRY_SEEDS must be a JSON array/);
    });

    it('rejects an entry missing the required secret', () => {
      expect(() =>
        loadConfig({
          ...base,
          ...fakeProviders,
          SERVICE_REGISTRY_SEEDS: JSON.stringify([{ client_id: 'sprout' }]),
        }),
      ).toThrow();
    });
  });
});
