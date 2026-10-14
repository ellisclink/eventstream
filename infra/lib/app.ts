import { Tags, type App } from 'aws-cdk-lib';

import { BudgetStack } from './budget-stack.js';
import type { AppConfig } from './config.js';
import { DEFAULT_INGEST_LIMITS, EventstreamStack } from './eventstream-stack.js';
import { GithubOidcStack } from './github-oidc-stack.js';
import { PROJECT_TAG } from './tags.js';

export { PROJECT_TAG };

export interface EventstreamApp {
  readonly eventstreamStack: EventstreamStack;
  readonly budgetStack: BudgetStack | undefined;
  readonly githubOidcStack: GithubOidcStack | undefined;
}

/**
 * Wires every stack into the app. Shared by the CLI entry point and the tests so both
 * synthesize exactly the same thing.
 */
export function buildApp(app: App, config: AppConfig): EventstreamApp {
  // Tags.of(app) reaches every taggable resource. Stack-level tags are passed explicitly
  // because the @aws-cdk/core:explicitStackTags flag stops Tags.of() from setting them;
  // CloudFormation then copies stack tags onto every resource it creates.
  Tags.of(app).add(PROJECT_TAG.key, PROJECT_TAG.value);
  const tags = { [PROJECT_TAG.key]: PROJECT_TAG.value };

  const eventstreamStack = new EventstreamStack(app, 'EventstreamStack', {
    env: config.env,
    tags,
    description: 'eventstream: serverless game telemetry pipeline',
    alertEmail: config.alertEmail,
    ingestLimits: {
      rateLimit: config.ingestRateLimit ?? DEFAULT_INGEST_LIMITS.rateLimit,
      burstLimit: 2 * (config.ingestRateLimit ?? DEFAULT_INGEST_LIMITS.rateLimit),
      dailyQuota: config.ingestDailyQuota ?? DEFAULT_INGEST_LIMITS.dailyQuota,
    },
  });

  const budgetStack =
    config.budgetEmail === undefined
      ? undefined
      : new BudgetStack(app, 'BudgetStack', {
          env: config.env,
          tags,
          description: 'eventstream: monthly AWS cost budget and email alert',
          budgetEmail: config.budgetEmail,
          monthlyLimitUsd: config.monthlyLimitUsd,
        });

  const githubOidcStack =
    config.githubRepo === undefined
      ? undefined
      : new GithubOidcStack(app, 'GithubOidcStack', {
          env: config.env,
          tags,
          description: 'eventstream: GitHub Actions OIDC deploy role',
          githubRepo: config.githubRepo,
          existingProviderArn: config.githubOidcProviderArn,
        });

  return { eventstreamStack, budgetStack, githubOidcStack };
}
