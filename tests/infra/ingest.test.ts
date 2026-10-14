import { Match, Template } from 'aws-cdk-lib/assertions';

import { eventstreamTemplate, synthApp } from './helpers';

describe('ingest path (Milestone 1)', () => {
  it('creates a main queue with a DLQ after 3 receives', () => {
    const template = eventstreamTemplate();
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 190,
      SqsManagedSseEnabled: true,
      RedrivePolicy: { maxReceiveCount: 3, deadLetterTargetArn: Match.anyValue() },
    });
    template.hasResourceProperties('AWS::SQS::Queue', { MessageRetentionPeriod: 14 * 24 * 3600 });
  });

  it('denies non-TLS access to the queues', () => {
    eventstreamTemplate().hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('runs the ingest Lambda on Node 22 ARM with the queue URL', () => {
    eventstreamTemplate().hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
      Environment: {
        Variables: Match.objectLike({
          POWERTOOLS_SERVICE_NAME: 'ingest',
          QUEUE_URL: Match.anyValue(),
        }),
      },
    });
  });

  it('lets ingest send to the queue and nothing more', () => {
    const policies = eventstreamTemplate().findResources('AWS::IAM::Policy');
    const ingestPolicy = Object.entries(policies).find(([id]) => id.startsWith('Ingest'))?.[1] as
      | { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } }
      | undefined;
    const actions = (ingestPolicy?.Properties.PolicyDocument.Statement ?? []).flatMap((st) =>
      Array.isArray(st.Action) ? st.Action : [st.Action],
    );

    expect(actions.filter((a) => a.startsWith('sqs:')).sort()).toEqual([
      'sqs:GetQueueAttributes',
      'sqs:GetQueueUrl',
      'sqs:SendMessage',
    ]);
  });

  it('exposes POST /events behind an API key', () => {
    const template = eventstreamTemplate();
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'events' });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      ApiKeyRequired: true,
      Integration: { Type: 'AWS_PROXY' },
    });
  });

  it('caps the producer key so a leaked key has a bounded cost', () => {
    const template = eventstreamTemplate();
    template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
      UsagePlanName: 'eventstream-ingest-plan',
      Throttle: { RateLimit: 20, BurstLimit: 40 },
      Quota: { Limit: 10_000, Period: 'DAY' },
    });
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([
        Match.objectLike({ ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 }),
      ]),
    });
  });

  it('gives ingest and stats separate APIs, each with its own key and plan', () => {
    const template = eventstreamTemplate();
    template.resourceCountIs('AWS::ApiGateway::RestApi', 2);
    template.resourceCountIs('AWS::ApiGateway::ApiKey', 2);
    template.resourceCountIs('AWS::ApiGateway::UsagePlanKey', 2);
    // POST /events lives only on the ingest API, so the producer key can't reach /stats.
    const posts = template.findResources('AWS::ApiGateway::Method', {
      Properties: { HttpMethod: 'POST' },
    });
    const restApiRefs = Object.values(posts).map(
      (m) => (m as { Properties: { RestApiId: { Ref: string } } }).Properties.RestApiId.Ref,
    );
    expect(restApiRefs).toEqual([expect.stringMatching(/^IngestApi/)]);
    const gets = template.findResources('AWS::ApiGateway::Method', {
      Properties: { HttpMethod: 'GET' },
    });
    for (const m of Object.values(gets) as { Properties: { RestApiId: { Ref: string } } }[]) {
      expect(m.Properties.RestApiId.Ref).toMatch(/^StatsApi/);
    }
  });

  it('lets the ingest limits be raised from context for a big load test', () => {
    const template = Template.fromStack(
      synthApp({ ingestRateLimit: '100', ingestDailyQuota: '200000' }).eventstreamStack,
    );
    template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
      UsagePlanName: 'eventstream-ingest-plan',
      Throttle: { RateLimit: 100, BurstLimit: 200 },
      Quota: { Limit: 200_000, Period: 'DAY' },
    });
  });

  it('never enables request body logging on the stage', () => {
    eventstreamTemplate().hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'dev',
      TracingEnabled: true,
      MethodSettings: Match.arrayWith([Match.objectLike({ DataTraceEnabled: false })]),
    });
  });
});
