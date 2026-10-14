import { Match } from 'aws-cdk-lib/assertions';

import { eventstreamTemplate } from './helpers';

function policyActions(prefix: string): string[] {
  const policies = eventstreamTemplate().findResources('AWS::IAM::Policy');
  const policy = Object.entries(policies).find(([id]) => id.startsWith(prefix))?.[1] as
    { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } } | undefined;
  return (policy?.Properties.PolicyDocument.Statement ?? []).flatMap((s) =>
    Array.isArray(s.Action) ? s.Action : [s.Action],
  );
}

describe('processor (Milestone 3)', () => {
  it('creates an on-demand table with pk/sk and a TTL attribute', () => {
    eventstreamTemplate().hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: 'expires_at', Enabled: true },
    });
  });

  it('deletes the table with the stack', () => {
    eventstreamTemplate().hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });

  it('consumes the queue with partial batch failure reporting', () => {
    eventstreamTemplate().hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 100,
      MaximumBatchingWindowInSeconds: 10,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 5 },
    });
  });

  it('runs with a 30 s timeout and the table name', () => {
    eventstreamTemplate().hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 30,
      Environment: {
        Variables: Match.objectLike({
          POWERTOOLS_SERVICE_NAME: 'processor',
          TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it('can write to the table but not read, scan or delete', () => {
    const dynamo = policyActions('Processor').filter((a) => a.startsWith('dynamodb:'));
    expect(dynamo.sort()).toEqual([
      'dynamodb:ConditionCheckItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ]);
  });

  it('can consume from the queue', () => {
    expect(policyActions('Processor')).toEqual(
      expect.arrayContaining([
        'sqs:ReceiveMessage',
        'sqs:DeleteMessage',
        'sqs:ChangeMessageVisibility',
      ]),
    );
  });
});
