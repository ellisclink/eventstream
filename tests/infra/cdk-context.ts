import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface CdkJson {
  context?: Record<string, unknown>;
}

/**
 * The feature flags in cdk.json change what CDK synthesizes (for example how stack tags
 * work), so tests must use them too or they would pass against different output than
 * `cdk synth` produces.
 */
export function cdkJsonContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const cdkJson = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'cdk.json'), 'utf8'),
  ) as CdkJson;
  // An empty bundling-stacks list skips esbuild for Lambda assets, keeping tests fast;
  // `cdk synth` and CI still bundle for real.
  return { ...cdkJson.context, 'aws:cdk:bundling-stacks': [], ...extra };
}
