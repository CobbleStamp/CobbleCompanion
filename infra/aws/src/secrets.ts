// Runtime secrets, stored as SSM Parameter Store `SecureString` parameters
// (Standard tier — free, vs Secrets Manager's $0.40/secret/mo; we don't use
// rotation). They are KMS-encrypted at rest with the free AWS-managed `aws/ssm`
// key. Pulumi creates each parameter with a `REPLACE_ME` placeholder so the
// instance's boot-time fetch succeeds from first launch; the REAL value is set
// out of band so plaintext never enters the IaC source or Pulumi state. The
// `ignoreChanges: ['value']` means a value you set later is never reverted by
// `pulumi up`.
//
// Populate once per stack, after `pulumi up`:
//   aws ssm put-parameter --name /cobblecompanion/OPENROUTER_API_KEY --type SecureString --overwrite --value '<key>'
//   aws ssm put-parameter --name /cobblecompanion/DATABASE_URL      --type SecureString --overwrite --value '<supabase pooled DSN>'
// then re-pull on the box (`docker restart cobble-app`) or replace the instance.
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

const tags = { Project: 'cobblecompanion', ManagedBy: 'pulumi' };

interface ParamSpec {
  /** SSM parameter name (leading slash by convention). */
  readonly name: string;
  /** The env var the app reads it as. */
  readonly envVar: string;
  readonly description: string;
}

const specs: readonly ParamSpec[] = [
  {
    name: '/cobblecompanion/OPENROUTER_API_KEY',
    envVar: 'OPENROUTER_API_KEY',
    description: 'OpenRouter LLM gateway API key. Consumed by the api.',
  },
  {
    name: '/cobblecompanion/DATABASE_URL',
    envVar: 'DATABASE_URL',
    description:
      'Supabase pooled (PgBouncer) DSN, port 6543 transaction mode. Consumed by the api.',
  },
  // NOTE: the Discord surface is always-on and single-tenant; its secret
  // (DISCORD_SERVICE_SECRET) and bot-token key (DISCORD_TOKEN_KEY) are supplied
  // inline via Pulumi config in compute.ts (like local docker's .env), not SSM.
];

export interface ManagedParameter {
  readonly envVar: string;
  readonly parameter: aws.ssm.Parameter;
}

export const parameters: readonly ManagedParameter[] = specs.map((spec) => {
  const parameter = new aws.ssm.Parameter(
    `param-${spec.envVar.toLowerCase()}`,
    {
      name: spec.name,
      type: 'SecureString', // default aws/ssm KMS key (free)
      value: 'REPLACE_ME',
      description: spec.description,
      tags,
    },
    // The real value is set out of band; never let pulumi overwrite it.
    { ignoreChanges: ['value'] },
  );
  return { envVar: spec.envVar, parameter };
});

/** ARNs of every managed parameter — used to scope the instance's read policy (iam.ts). */
export const parameterArns: pulumi.Output<string>[] = parameters.map((p) => p.parameter.arn);
