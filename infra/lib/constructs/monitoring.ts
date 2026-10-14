import { Duration } from 'aws-cdk-lib';
import type { RestApi } from 'aws-cdk-lib/aws-apigateway';
import {
  Alarm,
  AlarmStatusWidget,
  ComparisonOperator,
  Dashboard,
  GraphWidget,
  MathExpression,
  Metric,
  TextWidget,
  TreatMissingData,
  type IMetric,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import type { DeliveryStream } from 'aws-cdk-lib/aws-kinesisfirehose';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export const METRICS_NAMESPACE = 'Eventstream';

export interface MonitoringProps {
  /** Ingest and stats APIs. */
  readonly apis: RestApi[];
  readonly queue: Queue;
  readonly deadLetterQueue: Queue;
  readonly functions: {
    readonly ingest: IFunction;
    readonly processor: IFunction;
    readonly query: IFunction;
  };
  readonly table: TableV2;
  readonly deliveryStream: DeliveryStream;
  readonly alertEmail?: string | undefined;
}

const FIVE_MINUTES = Duration.minutes(5);

/** Lambda metric summed over every function in the account and region. */
function accountLambdaMetric(metricName: string): Metric {
  return new Metric({
    namespace: 'AWS/Lambda',
    metricName,
    statistic: 'Sum',
    period: FIVE_MINUTES,
  });
}

/** A custom metric emitted by Powertools (EMF); Powertools adds a `service` dimension. */
function appMetric(service: string, metricName: string, statistic = 'Sum'): Metric {
  return new Metric({
    namespace: METRICS_NAMESPACE,
    metricName,
    dimensionsMap: { service },
    statistic,
    period: FIVE_MINUTES,
  });
}

/**
 * One dashboard and a small set of alarms that answer "is the pipeline healthy?".
 * CloudWatch bills alarms per metric they evaluate, with 10 free: these 8 alarms use exactly
 * 10 metrics, so alerting is free. A test pins the count.
 */
export class Monitoring extends Construct {
  readonly topic: Topic;
  readonly dashboard: Dashboard;
  readonly alarms: Alarm[] = [];

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);
    const { apis, queue, deadLetterQueue, functions, table, deliveryStream } = props;
    const allFunctions = [functions.ingest, functions.processor, functions.query];

    // Alarm notifications carry no event data, and CloudWatch can't publish to topics
    // encrypted with the AWS-managed SNS key, so the topic only enforces TLS.
    this.topic = new Topic(this, 'AlertTopic', {
      displayName: 'eventstream alerts',
      enforceSSL: true,
    });
    if (props.alertEmail !== undefined) {
      // AWS emails a confirmation link; alerts arrive only after it is clicked.
      this.topic.addSubscription(new EmailSubscription(props.alertEmail));
    }
    const action = new SnsAction(this.topic);

    const alarm = (
      name: string,
      metric: IMetric,
      threshold: number,
      description: string,
      evaluationPeriods = 1,
    ): Alarm => {
      const created = new Alarm(this, name, {
        alarmName: `eventstream-${name}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        // No data means no traffic, which is healthy for a pipeline that idles at zero.
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      created.addAlarmAction(action);
      created.addOkAction(action);
      this.alarms.push(created);
      return created;
    };

    const sumOf = (label: string, metrics: IMetric[]) =>
      new MathExpression({
        label,
        // FILL(m, 0): Lambda publishes Errors/Throttles only for periods it was invoked, and
        // metric math yields no datapoint unless every operand has one, so without FILL an
        // idle function would hide another function's errors.
        expression: metrics.map((_, i) => `FILL(m${String(i)}, 0)`).join(' + '),
        usingMetrics: Object.fromEntries(metrics.map((m, i) => [`m${String(i)}`, m])),
        period: FIVE_MINUTES,
      });

    // --- Alarms -----------------------------------------------------------------------
    alarm(
      'dlq-not-empty',
      deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: FIVE_MINUTES,
        statistic: 'Maximum',
      }),
      0,
      'Messages failed processing 3 times and are in the DLQ. Inspect, fix, then redrive.',
    );
    alarm(
      'queue-backlog-age',
      queue.metricApproximateAgeOfOldestMessage({ period: FIVE_MINUTES, statistic: 'Maximum' }),
      300,
      'The oldest queued event has waited over 5 minutes: the processor is failing or too slow.',
      2,
    );
    alarm(
      'lambda-errors',
      // Account-wide (no FunctionName dimension): one billed metric instead of one per
      // function. In a dedicated account that means this project's functions, plus CDK's
      // small helper functions, which should never error either.
      accountLambdaMetric('Errors'),
      0,
      'A Lambda function threw an error (unhandled exception or timeout).',
    );
    alarm(
      'lambda-throttles',
      accountLambdaMetric('Throttles'),
      0,
      'Lambda invocations were throttled; check account concurrency.',
    );
    alarm(
      'api-5xx',
      sumOf(
        'API 5xx',
        apis.map((api) => api.metricServerError({ period: FIVE_MINUTES, statistic: 'Sum' })),
      ),
      5,
      'API Gateway returned more than 5 server errors in 5 minutes.',
    );
    alarm(
      'ingest-reject-rate',
      new MathExpression({
        label: 'Rejected event %',
        // Ignore tiny volumes so a single bad test request doesn't page anyone.
        expression: 'IF(accepted + rejected >= 50, 100 * rejected / (accepted + rejected), 0)',
        usingMetrics: {
          accepted: appMetric('ingest', 'EventsAccepted'),
          rejected: appMetric('ingest', 'EventsRejected'),
        },
        period: FIVE_MINUTES,
      }),
      20,
      'More than 20% of submitted events failed validation: a client may be sending a bad schema.',
    );
    alarm(
      'processing-failures',
      // ProcessingFailures already includes archive failures: one metric, one charge.
      appMetric('processor', 'ProcessingFailures'),
      10,
      'The processor failed to apply or archive events repeatedly; they will retry, then hit the DLQ.',
      2,
    );
    alarm(
      'archive-freshness',
      deliveryStream.metric('DeliveryToS3.DataFreshness', {
        period: FIVE_MINUTES,
        statistic: 'Maximum',
      }),
      900,
      'Firehose holds records older than 15 minutes: delivery to S3 is failing.',
    );

    // --- Dashboard --------------------------------------------------------------------
    const graph = (title: string, left: IMetric[], right: IMetric[] = []) =>
      new GraphWidget({ title, left, right, width: 8, height: 6 });

    this.dashboard = new Dashboard(this, 'Dashboard', {
      dashboardName: 'eventstream',
      defaultInterval: Duration.hours(3),
    });
    this.dashboard.addWidgets(
      new TextWidget({
        markdown:
          '# eventstream\nAPI → ingest → SQS → processor → DynamoDB + Firehose → S3/Athena. Alarms email the SNS topic.',
        width: 24,
        height: 2,
      }),
    );
    this.dashboard.addWidgets(
      new AlarmStatusWidget({ title: 'Alarms', alarms: this.alarms, width: 24, height: 3 }),
    );
    this.dashboard.addWidgets(
      graph(
        'API requests and errors',
        apis.map((api) => api.metricCount({ period: Duration.minutes(1) })),
        apis.flatMap((api) => [
          api.metricClientError({ period: Duration.minutes(1) }),
          api.metricServerError({ period: Duration.minutes(1) }),
        ]),
      ),
      graph(
        'API latency p99 (ms)',
        apis.map((api) => api.metricLatency({ statistic: 'p99', period: Duration.minutes(1) })),
      ),
      graph('Ingest outcomes (events)', [
        appMetric('ingest', 'EventsAccepted'),
        appMetric('ingest', 'EventsRejected'),
        appMetric('ingest', 'EventsQueueFailed'),
        appMetric('ingest', 'MalformedRequests'),
      ]),
    );
    this.dashboard.addWidgets(
      graph('Queue depth', [
        queue.metricApproximateNumberOfMessagesVisible({ statistic: 'Maximum' }),
        deadLetterQueue.metricApproximateNumberOfMessagesVisible({ statistic: 'Maximum' }),
      ]),
      graph('Oldest message age (s)', [
        queue.metricApproximateAgeOfOldestMessage({ statistic: 'Maximum' }),
      ]),
      graph('Processor outcomes (events)', [
        appMetric('processor', 'EventsProcessed'),
        appMetric('processor', 'DuplicatesSkipped'),
        appMetric('processor', 'ProcessingFailures'),
        appMetric('processor', 'ArchiveFailures'),
      ]),
    );
    this.dashboard.addWidgets(
      graph('Ingest → processed delay (ms)', [
        appMetric('processor', 'IngestToProcessMs', 'p50'),
        appMetric('processor', 'IngestToProcessMs', 'p99'),
      ]),
      graph(
        'Lambda duration p99 (ms)',
        allFunctions.map((f) => f.metricDuration({ statistic: 'p99' })),
      ),
      graph(
        'Lambda errors / throttles',
        allFunctions.map((f) => f.metricErrors()),
        allFunctions.map((f) => f.metricThrottles()),
      ),
    );
    this.dashboard.addWidgets(
      graph('DynamoDB consumed capacity', [
        table.metricConsumedWriteCapacityUnits(),
        table.metricConsumedReadCapacityUnits(),
      ]),
      graph('Firehose records in / delivered', [
        deliveryStream.metricIncomingRecords(),
        deliveryStream.metric('DeliveryToS3.Records', { statistic: 'Sum' }),
      ]),
      graph('Firehose data freshness (s)', [
        deliveryStream.metric('DeliveryToS3.DataFreshness', { statistic: 'Maximum' }),
      ]),
    );
  }
}
