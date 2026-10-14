import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { FirehoseClient } from '@aws-sdk/client-firehose';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';

import { requireEnv } from '../../shared/src/env.js';
import { createObservability } from '../../shared/src/observability.js';
import { sendToArchive } from './archive.js';
import { processBatch } from './process-batch.js';
import { applyPlayerEvents } from './stats-store.js';

const { logger, metrics, tracer } = createObservability('processor');
const tableName = requireEnv('TABLE_NAME');
const deliveryStreamName = requireEnv('DELIVERY_STREAM_NAME');
// Clients live outside the handler so warm invocations reuse their connections.
const db = DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})));
const firehose = tracer.captureAWSv3Client(new FirehoseClient({}));

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  logger.addContext(context);
  try {
    const { response, stats } = await processBatch(event.Records, {
      applyGroup: (events) => applyPlayerEvents(db, tableName, events, new Date()),
      archive: (events) => sendToArchive(firehose, deliveryStreamName, events),
      onError: (message, details) => {
        logger.warn(message, details);
      },
    });

    metrics.addMetric('EventsProcessed', MetricUnit.Count, stats.applied);
    metrics.addMetric('DuplicatesSkipped', MetricUnit.Count, stats.duplicates);
    // One combined failure metric keeps the alarm to a single (billed) metric; ArchiveFailures
    // is also emitted separately for the dashboard.
    metrics.addMetric(
      'ProcessingFailures',
      MetricUnit.Count,
      stats.failed + stats.invalid + stats.archiveFailed,
    );
    metrics.addMetric('ArchiveFailures', MetricUnit.Count, stats.archiveFailed);
    for (const delay of stats.delaysMs) {
      metrics.addMetric('IngestToProcessMs', MetricUnit.Milliseconds, delay);
    }

    logger.info('batch processed', {
      records: event.Records.length,
      applied: stats.applied,
      duplicates: stats.duplicates,
      failed: stats.failed,
      invalid: stats.invalid,
      archiveFailed: stats.archiveFailed,
    });
    return response;
  } finally {
    metrics.publishStoredMetrics();
  }
}
