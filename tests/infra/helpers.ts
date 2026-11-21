import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { buildApp } from '../../infra/lib/app';
import { readConfig } from '../../infra/lib/config';
import { cdkJsonContext } from './cdk-context';

/** Synthesizes the app the way the CLI does (same feature flags), without AWS credentials. */
export function synthApp(context: Record<string, unknown> = {}) {
  const app = new App({ context: cdkJsonContext(context) });
  const stacks = buildApp(app, readConfig(app.node, {}));
  return { app, ...stacks };
}

let cached: Template | undefined;

/** EventstreamStack template, synthesized once per test file because synthesis is slow. */
export function eventstreamTemplate(): Template {
  cached ??= Template.fromStack(synthApp().eventstreamStack);
  return cached;
}
