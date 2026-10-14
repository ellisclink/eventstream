import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import type { Construct } from 'constructs';

import { Api, type ApiLimits } from './constructs/api.js';
import { Archive } from './constructs/archive.js';
import { EventQueue } from './constructs/event-queue.js';
import { Monitoring } from './constructs/monitoring.js';
import { ServiceFunction } from './constructs/service-function.js';
import { StatsTable } from './constructs/stats-table.js';

/** Processor timeout; the queue's visibility timeout is derived from it. */
export const PROCESSOR_TIMEOUT = Duration.seconds(30);
export const PROCESSOR_BATCHING_WINDOW = Duration.seconds(10);

export interface EventstreamStackProps extends StackProps {
  /** Email for alarm notifications; no subscription is created when undefined. */
  readonly alertEmail?: string | undefined;
  readonly ingestLimits?: ApiLimits | undefined;
  readonly statsLimits?: ApiLimits | undefined;
}

/**
 * Defaults sized so that a leaked key cannot outrun the $5 budget by much: the ingest quota
 * allows at most 1M events a day (10,000 requests x 100 events), about $3-6 of processing.
 */
export const DEFAULT_INGEST_LIMITS: ApiLimits = {
  rateLimit: 20,
  burstLimit: 40,
  dailyQuota: 10_000,
};
export const DEFAULT_STATS_LIMITS: ApiLimits = { rateLimit: 10, burstLimit: 20, dailyQuota: 5_000 };

/** The telemetry pipeline: API, queue, Lambdas, tables, archive and monitoring. */
export class EventstreamStack extends Stack {
  readonly ingestApi: Api;
  readonly statsApi: Api;
  readonly events: EventQueue;
  readonly ingestFunction: ServiceFunction;
  readonly stats: StatsTable;
  readonly processorFunction: ServiceFunction;
  readonly queryFunction: ServiceFunction;
  readonly archive: Archive;
  readonly monitoring: Monitoring;

  constructor(scope: Construct, id: string, props: EventstreamStackProps = {}) {
    super(scope, id, props);

    // --- Milestone 1: ingest ---------------------------------------------------------
    this.ingestApi = new Api(this, 'IngestApi', {
      restApiName: 'eventstream-ingest',
      description: 'eventstream: POST /events for game clients and the load generator',
      keyDescription: 'Producer key (game clients, load generator). Can only send events.',
      limits: props.ingestLimits ?? DEFAULT_INGEST_LIMITS,
    });
    this.events = new EventQueue(this, 'Events', {
      consumerTimeout: PROCESSOR_TIMEOUT,
      consumerBatchingWindow: PROCESSOR_BATCHING_WINDOW,
    });

    this.ingestFunction = new ServiceFunction(this, 'Ingest', {
      service: 'ingest',
      environment: { QUEUE_URL: this.events.queue.queueUrl },
    });
    // Send-only: ingest can't read or delete messages.
    this.events.queue.grantSendMessages(this.ingestFunction.function);

    const eventsResource = this.ingestApi.restApi.root.addResource('events');
    this.ingestApi.addRoute(eventsResource, 'POST', this.ingestFunction.function);

    // --- Milestone 3: processor ------------------------------------------------------
    this.stats = new StatsTable(this, 'Stats');
    this.processorFunction = new ServiceFunction(this, 'Processor', {
      service: 'processor',
      timeout: PROCESSOR_TIMEOUT,
      environment: { TABLE_NAME: this.stats.table.tableName },
    });
    // Transactions need the per-item actions; nothing here reads, scans or deletes.
    this.stats.table.grant(
      this.processorFunction.function,
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:ConditionCheckItem',
    );
    this.processorFunction.function.addEventSource(
      new SqsEventSource(this.events.queue, {
        // Big batches group more events per player, and each player group is one DynamoDB
        // transaction, so this is the main cost lever. Waiting up to 10 s to fill a batch
        // also means fewer Lambda invocations; aggregates lag by at most ~10 s.
        batchSize: 100,
        maxBatchingWindow: PROCESSOR_BATCHING_WINDOW,
        reportBatchItemFailures: true,
        // Caps how hard a backlog can hit DynamoDB, and how many Lambdas run at once.
        maxConcurrency: 5,
      }),
    );

    // --- Milestone 4: query API -------------------------------------------------------
    this.queryFunction = new ServiceFunction(this, 'Query', {
      service: 'query',
      environment: { TABLE_NAME: this.stats.table.tableName },
    });
    // Read-only, and only point reads: no Scan or Query, so a bug can't page the table.
    this.stats.table.grant(
      this.queryFunction.function,
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
    );

    // A separate API and key: the producer key ships inside game clients, so it must not be
    // able to read every player's stats and revenue.
    this.statsApi = new Api(this, 'StatsApi', {
      restApiName: 'eventstream-stats',
      description: 'eventstream: read-only GET /stats/* for dashboards and operators',
      keyDescription: 'Reader key (dashboards, operators). Can only read stats.',
      limits: props.statsLimits ?? DEFAULT_STATS_LIMITS,
    });
    const stats = this.statsApi.restApi.root.addResource('stats');
    const players = stats.addResource('players').addResource('{playerId}');
    const daily = stats.addResource('daily');
    this.statsApi.addRoute(players, 'GET', this.queryFunction.function);
    this.statsApi.addRoute(daily, 'GET', this.queryFunction.function);
    this.statsApi.addRoute(daily.addResource('{date}'), 'GET', this.queryFunction.function);

    // --- Milestone 5: archive ---------------------------------------------------------
    this.archive = new Archive(this, 'Archive');
    this.processorFunction.function.addEnvironment(
      'DELIVERY_STREAM_NAME',
      this.archive.deliveryStream.deliveryStreamName,
    );
    this.archive.deliveryStream.grantPutRecords(this.processorFunction.function);

    // --- Milestone 6: observability ---------------------------------------------------
    this.monitoring = new Monitoring(this, 'Monitoring', {
      apis: [this.ingestApi.restApi, this.statsApi.restApi],
      queue: this.events.queue,
      deadLetterQueue: this.events.deadLetterQueue,
      functions: {
        ingest: this.ingestFunction.function,
        processor: this.processorFunction.function,
        query: this.queryFunction.function,
      },
      table: this.stats.table,
      deliveryStream: this.archive.deliveryStream,
      alertEmail: props.alertEmail,
    });
  }
}
