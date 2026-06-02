import { z } from 'zod';

/**
 * Runtime configuration (implementation.md §3). Required secrets are validated at
 * startup — fail fast (security.md). Tests construct an AppConfig directly.
 */
export interface AppConfig {
  readonly databaseUrl: string;
  readonly llmProvider: 'openrouter' | 'fake';
  readonly openrouterApiKey: string;
  readonly llmModel: string;
  readonly sessionSecret: string;
  readonly appUrl: string;
  readonly emailTransport: 'console' | 'smtp';
  readonly port: number;
  readonly isProduction: boolean;
}

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    LLM_PROVIDER: z.enum(['openrouter', 'fake']).default('openrouter'),
    OPENROUTER_API_KEY: z.string().default(''),
    LLM_MODEL: z.string().default('anthropic/claude-3.5-sonnet'),
    AUTH_SESSION_SECRET: z.string().min(32, 'AUTH_SESSION_SECRET must be >=32 chars'),
    APP_URL: z.string().url().default('http://localhost:3001'),
    EMAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
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
  });

/** Load and validate config from the environment; throws on invalid config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    llmProvider: parsed.LLM_PROVIDER,
    openrouterApiKey: parsed.OPENROUTER_API_KEY,
    llmModel: parsed.LLM_MODEL,
    sessionSecret: parsed.AUTH_SESSION_SECRET,
    appUrl: parsed.APP_URL,
    emailTransport: parsed.EMAIL_TRANSPORT,
    port: parsed.PORT,
    isProduction: parsed.NODE_ENV === 'production',
  };
}
