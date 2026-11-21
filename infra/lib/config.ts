import type { Environment } from 'aws-cdk-lib';
import type { Node } from 'constructs';
import { z } from 'zod';

export const DEFAULT_MONTHLY_LIMIT_USD = 5;

export interface AppConfig {
  /** Undefined when no `budgetEmail` context was given; BudgetStack is then skipped. */
  readonly budgetEmail: string | undefined;
  /** Alarm email; `alertEmail` context, falling back to budgetEmail. Undefined = no subscription. */
  readonly alertEmail: string | undefined;
  readonly monthlyLimitUsd: number;
  /** "owner/repo" for the CI deploy role; GithubOidcStack is skipped when undefined. */
  readonly githubRepo: string | undefined;
  readonly githubOidcProviderArn: string | undefined;
  /** Overrides for the ingest key; undefined keeps the defaults in eventstream-stack.ts. */
  readonly ingestRateLimit: number | undefined;
  readonly ingestDailyQuota: number | undefined;
  readonly env: Environment;
}

const emailSchema = z.email();
const limitSchema = z.coerce.number().positive().max(1000);
const rateSchema = z.coerce.number().int().min(1).max(1000);
const quotaSchema = z.coerce.number().int().min(100).max(1_000_000);
const repoSchema = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
const arnSchema = z.string().regex(/^arn:aws[a-z-]*:iam::\d{12}:oidc-provider\/.+$/);

/**
 * Reads deployment settings from CDK context (`-c key=value` or cdk.json) and the CDK
 * environment variables the CLI sets from the active AWS profile. Nothing account-specific
 * lives in the code.
 */
export function readConfig(node: Node, processEnv: NodeJS.ProcessEnv = process.env): AppConfig {
  const budgetEmail = readEmail(node, 'budgetEmail');
  const alertEmail = readEmail(node, 'alertEmail') ?? budgetEmail;

  const rawLimit: unknown = node.tryGetContext('budgetLimitUsd');
  let monthlyLimitUsd = DEFAULT_MONTHLY_LIMIT_USD;
  if (rawLimit !== undefined) {
    const parsed = limitSchema.safeParse(rawLimit);
    if (!parsed.success) {
      throw new Error('Context value "budgetLimitUsd" must be a positive number up to 1000.');
    }
    monthlyLimitUsd = parsed.data;
  }

  const githubRepo = readMatching(node, 'githubRepo', repoSchema, 'owner/repo');
  const githubOidcProviderArn = readMatching(
    node,
    'githubOidcProviderArn',
    arnSchema,
    'an IAM OIDC provider ARN',
  );

  const ingestRateLimit = readNumber(
    node,
    'ingestRateLimit',
    rateSchema,
    'an integer from 1 to 1000',
  );
  const ingestDailyQuota = readNumber(
    node,
    'ingestDailyQuota',
    quotaSchema,
    'an integer from 100 to 1000000',
  );

  return {
    budgetEmail,
    alertEmail,
    monthlyLimitUsd,
    githubRepo,
    githubOidcProviderArn,
    ingestRateLimit,
    ingestDailyQuota,
    env: cdkEnvironment(processEnv),
  };
}

function readNumber(
  node: Node,
  key: string,
  schema: z.ZodType<number>,
  expected: string,
): number | undefined {
  const raw: unknown = node.tryGetContext(key);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Context value "${key}" must be ${expected}.`);
  }
  return parsed.data;
}

function readMatching(
  node: Node,
  key: string,
  schema: z.ZodString,
  expected: string,
): string | undefined {
  const raw: unknown = node.tryGetContext(key);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Context value "${key}" must be ${expected}.`);
  }
  return parsed.data;
}

function readEmail(node: Node, key: string): string | undefined {
  const raw: unknown = node.tryGetContext(key);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parsed = emailSchema.safeParse(typeof raw === 'string' ? raw.trim() : raw);
  if (!parsed.success) {
    throw new Error(`Context value "${key}" must be a valid email address.`);
  }
  return parsed.data;
}

/**
 * Leaves account/region unset when the CLI has no credentials (e.g. CI synth), which makes
 * the stacks environment-agnostic instead of failing.
 */
function cdkEnvironment(processEnv: NodeJS.ProcessEnv): Environment {
  const account = processEnv['CDK_DEFAULT_ACCOUNT'];
  const region = processEnv['CDK_DEFAULT_REGION'];
  return {
    ...(account ? { account } : {}),
    ...(region ? { region } : {}),
  };
}
