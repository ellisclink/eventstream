import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface EventQueueProps {
  /** Processor Lambda timeout; the visibility timeout is derived from it. */
  readonly consumerTimeout: Duration;
  /** The event source batching window; messages wait this long before a consumer sees them. */
  readonly consumerBatchingWindow: Duration;
  /** Deliveries before a message moves to the DLQ. */
  readonly maxReceiveCount?: number;
}

/**
 * The buffer between ingest and processing. If the processor is slow or failing, events
 * wait here instead of being lost, and messages that keep failing land in the DLQ.
 */
export class EventQueue extends Construct {
  readonly queue: Queue;
  readonly deadLetterQueue: Queue;

  constructor(scope: Construct, id: string, props: EventQueueProps) {
    super(scope, id);

    this.deadLetterQueue = new Queue(this, 'DeadLetterQueue', {
      retentionPeriod: Duration.days(14),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.queue = new Queue(this, 'Queue', {
      // AWS guidance: at least 6x the consumer timeout plus the batching window, so a
      // message is not redelivered while a slow invocation (including its retries) still
      // has it.
      visibilityTimeout: Duration.seconds(
        props.consumerTimeout.toSeconds() * 6 + props.consumerBatchingWindow.toSeconds(),
      ),
      retentionPeriod: Duration.days(4),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: props.maxReceiveCount ?? 3,
      },
    });
  }
}
