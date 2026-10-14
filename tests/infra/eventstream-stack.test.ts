import { App } from 'aws-cdk-lib';
import { Match } from 'aws-cdk-lib/assertions';

import { PROJECT_TAG, buildApp } from '../../infra/lib/app';
import { readConfig } from '../../infra/lib/config';
import { cdkJsonContext } from './cdk-context';
import { eventstreamTemplate, synthApp } from './helpers';

describe('EventstreamStack', () => {
  it('carries the project=eventstream tag', () => {
    const { app, eventstreamStack } = synthApp();
    // Tags are applied by an aspect during synthesis, so synthesize before reading them.
    const assembly = app.synth();

    expect(eventstreamStack.tags.tagValues()).toEqual({ [PROJECT_TAG.key]: PROJECT_TAG.value });
    // Stack tags in the cloud assembly are what CloudFormation copies onto every resource.
    expect(assembly.getStackByName(eventstreamStack.stackName).tags).toEqual({
      [PROJECT_TAG.key]: PROJECT_TAG.value,
    });
  });

  it('tags taggable resources directly as well', () => {
    const tag = Match.arrayWith([{ Key: PROJECT_TAG.key, Value: PROJECT_TAG.value }]);
    eventstreamTemplate().hasResourceProperties('AWS::SQS::Queue', { Tags: tag });
    eventstreamTemplate().hasResourceProperties('AWS::Lambda::Function', { Tags: tag });
  });

  it('is environment-agnostic when no account or region is set', () => {
    const { eventstreamStack } = synthApp();
    expect(eventstreamStack.environment).toBe('aws://unknown-account/unknown-region');
  });

  it('uses the CDK environment variables for account and region', () => {
    const app = new App({ context: cdkJsonContext() });
    const config = readConfig(app.node, {
      CDK_DEFAULT_ACCOUNT: '111111111111',
      CDK_DEFAULT_REGION: 'eu-west-2',
    });
    const { eventstreamStack } = buildApp(app, config);

    expect(eventstreamStack.account).toBe('111111111111');
    expect(eventstreamStack.region).toBe('eu-west-2');
  });

  it('skips BudgetStack when no budgetEmail context is given', () => {
    const { app, budgetStack } = synthApp();
    expect(budgetStack).toBeUndefined();
    expect(app.node.tryFindChild('BudgetStack')).toBeUndefined();
  });

  it('sets a one-week retention on every log group', () => {
    const groups = eventstreamTemplate().findResources('AWS::Logs::LogGroup');
    expect(Object.keys(groups).length).toBeGreaterThan(0);
    for (const group of Object.values(groups) as { Properties: { RetentionInDays?: number } }[]) {
      expect(group.Properties.RetentionInDays).toBe(7);
    }
  });
});
