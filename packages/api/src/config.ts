import { z } from 'zod';

/**
 * Authentication mode. `google` (default) gates the app behind Google Sign-In:
 * the SPA obtains a Google ID token and the API verifies it as a bearer JWT
 * against Google's JWKS. `dev_bypass` skips Google entirely so the app can run
 * locally and in tests with no live provider. Default is `google`, so
 * production is never accidentally open.
 */
export type AuthMode = 'google' | 'dev_bypass';

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
  readonly googleClientId: string;
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
    AUTH_MODE: z.enum(['google', 'dev_bypass']).default('google'),
    // Public OAuth Web client ID — shipped to the browser, not a secret.
    GOOGLE_CLIENT_ID: z.string().default(''),
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
    if (env.AUTH_MODE === 'google' && env.GOOGLE_CLIENT_ID.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GOOGLE_CLIENT_ID is required when AUTH_MODE=google',
        path: ['GOOGLE_CLIENT_ID'],
      });
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
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    devBypassEmail: parsed.DEV_BYPASS_EMAIL,
    port: parsed.PORT,
    isProduction: parsed.NODE_ENV === 'production',
  };
}
