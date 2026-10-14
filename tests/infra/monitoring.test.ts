import { Match, Template } from 'aws-cdk-lib/assertions';

import { METRICS_NAMESPACE } from '../../infra/lib/constructs/monitoring';
import { METRICS_NAMESPACE as EMITTED_NAMESPACE } from '../../services/shared/src/observability';
import { eventstreamTemplate, synthApp } from './helpers';

describe('monitoring (Milestone 6)', () => {
  it('alarms on the 8 health signals', () => {
    const alarms = eventstreamTemplate().findResources('AWS::CloudWatch::Alarm');
    const names = Object.values(alarms).map(
      (a) => (a as { Properties: { AlarmName: string } }).Properties.AlarmName,
    );
    expect(names.sort()).toEqual([
      'eventstream-api-5xx',
      'eventstream-archive-freshness',
      'eventstream-dlq-not-empty',
      'eventstream-ingest-reject-rate',
      'eventstream-lambda-errors',
      'eventstream-lambda-throttles',
      'eventstream-processing-failures',
      'eventstream-queue-backlog-age',
    ]);
  });

  it('sends both ALARM and OK notifications to the SNS topic, and idles quietly', () => {
    const alarms = eventstreamTemplate().findResources('AWS::CloudWatch::Alarm');
    for (const alarm of Object.values(alarms) as {
      Properties: { AlarmActions: unknown[]; OKActions: unknown[]; TreatMissingData: string };
    }[]) {
      expect(alarm.Properties.AlarmActions).toEqual([
        { Ref: expect.stringMatching(/AlertTopic/) as unknown },
      ]);
      expect(alarm.Properties.OKActions).toHaveLength(1);
      expect(alarm.Properties.TreatMissingData).toBe('notBreaching');
    }
  });

  it('alarms as soon as anything reaches the DLQ', () => {
    eventstreamTemplate().hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'eventstream-dlq-not-empty',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      MetricName: 'ApproximateNumberOfMessagesVisible',
    });
  });

  it('watches the custom Powertools metrics in the namespace the Lambdas emit to', () => {
    expect(METRICS_NAMESPACE).toBe(EMITTED_NAMESPACE);
    eventstreamTemplate().hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'eventstream-ingest-reject-rate',
      Metrics: Match.arrayWith([
        Match.objectLike({
          MetricStat: Match.objectLike({
            Metric: Match.objectLike({
              Namespace: METRICS_NAMESPACE,
              MetricName: 'EventsRejected',
              Dimensions: [{ Name: 'service', Value: 'ingest' }],
            }),
          }),
        }),
      ]),
    });
  });

  it('creates the dashboard', () => {
    eventstreamTemplate().hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'eventstream',
    });
  });

  it('enforces TLS on the alert topic', () => {
    eventstreamTemplate().hasResourceProperties('AWS::SNS::TopicPolicy', {
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

  it('subscribes no email unless one is configured', () => {
    eventstreamTemplate().resourceCountIs('AWS::SNS::Subscription', 0);
  });

  it('subscribes alertEmail, falling back to budgetEmail', () => {
    const withAlert = Template.fromStack(
      synthApp({ alertEmail: 'oncall@example.com' }).eventstreamStack,
    );
    withAlert.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'oncall@example.com',
    });

    const fallback = Template.fromStack(
      synthApp({ budgetEmail: 'me@example.com' }).eventstreamStack,
    );
    fallback.hasResourceProperties('AWS::SNS::Subscription', { Endpoint: 'me@example.com' });
  });

  it('turns on X-Ray tracing for every function and the API stage', () => {
    const functions = eventstreamTemplate().findResources('AWS::Lambda::Function', {
      Properties: { Runtime: 'nodejs22.x' },
    });
    expect(Object.keys(functions)).toHaveLength(3);
    for (const fn of Object.values(functions) as {
      Properties: { TracingConfig?: { Mode: string } };
    }[]) {
      expect(fn.Properties.TracingConfig?.Mode).toBe('Active');
    }
  });
});

describe('alarm cost', () => {
  it('evaluates exactly 10 metrics in total, the CloudWatch free tier', () => {
    const alarms = eventstreamTemplate().findResources('AWS::CloudWatch::Alarm');
    const metricCount = Object.values(alarms)
      .map((a) => (a as { Properties: { Metrics?: { MetricStat?: unknown }[] } }).Properties)
      .reduce((sum, p) => sum + (p.Metrics ? p.Metrics.filter((m) => m.MetricStat).length : 1), 0);
    expect(metricCount).toBe(10);
  });

  it('watches Lambda errors account-wide as one metric', () => {
    eventstreamTemplate().hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'eventstream-lambda-errors',
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Dimensions: Match.absent(),
    });
  });

  it('fills missing datapoints when summing both APIs', () => {
    eventstreamTemplate().hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'eventstream-api-5xx',
      Metrics: Match.arrayWith([Match.objectLike({ Expression: 'FILL(m0, 0) + FILL(m1, 0)' })]),
    });
  });
});
