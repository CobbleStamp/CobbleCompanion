import { z } from 'zod';

/**
 * Authentication mode. `auth0` (default) gates the app behind Auth0 Universal
 * Login + Google SSO, validating bearer tokens against the tenant's JWKS.
 * `dev_bypass` skips Auth0 entirely so the app can run locally and in tests
 * with no live tenant — the analog of CobbleBrowse's `caddy_bypass`. Default is
 * `auth0`, so production is never accidentally open.
 */
export type AuthMode = 'auth0' | 'dev_bypass';

/**
 * Runtime configuration (implementation.md §3). Required secrets are validated at
 * startup — fail fast (security.md). Tests construct an AppConfig directly.
 */
export interface AppConfig {
  readonly databaseUrl: string;
  readonly llmProvider: 'openrouter' | 'fake';
  readonly openrouterApiKey: string;
  readonly llmModel: string;
  readonly appUrl: string;
  readonly authMode: AuthMode;
  readonly auth0Domain: string;
  readonly auth0ClientId: string;
  readonly auth0Audience: string;
  readonly devBypassEmail: string;
  readonly port: number;
  readonly isProduction: boolean;
}

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    LLM_PROVIDER: z.enum(['openrouter', 'fake']).default('openrouter'),
    OPENROUTER_API_KEY: z.string().default(''),
    LLM_MODEL: z.string().default('anthropic/claude-3.5-sonnet'),
    APP_URL: z.string().url().default('http://localhost:3001'),
    AUTH_MODE: z.enum(['auth0', 'dev_bypass']).default('auth0'),
    AUTH0_DOMAIN: z.string().default(''),
    AUTH0_CLIENT_ID: z.string().default(''),
    AUTH0_AUDIENCE: z.string().default(''),
    DEV_BYPASS_EMAIL: z.string().email().default('dev@cobble.local'),
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.string().default('development'),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER === 'openrouter' && env.OPENROUTER_API_KEY.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter',
        path: ['OPENROUTER_API_KEY'],
      });
    }
    if (env.AUTH_MODE === 'auth0') {
      for (const key of ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_AUDIENCE'] as const) {
        if (env[key].length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${key} is required when AUTH_MODE=auth0`,
            path: [key],
          });
        }
      }
    }
  });

/** Load and validate config from the environment; throws on invalid config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    llmProvider: parsed.LLM_PROVIDER,
    openrouterApiKey: parsed.OPENROUTER_API_KEY,
    llmModel: parsed.LLM_MODEL,
    appUrl: parsed.APP_URL,
    authMode: parsed.AUTH_MODE,
    auth0Domain: parsed.AUTH0_DOMAIN,
    auth0ClientId: parsed.AUTH0_CLIENT_ID,
    auth0Audience: parsed.AUTH0_AUDIENCE,
    devBypassEmail: parsed.DEV_BYPASS_EMAIL,
    port: parsed.PORT,
    isProduction: parsed.NODE_ENV === 'production',
  };
}
