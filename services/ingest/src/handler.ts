import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

import { requireEnv } from '../../shared/src/env.js';
import { decodeBody, json } from '../../shared/src/http.js';
import { createObservability } from '../../shared/src/observability.js';
import { ingest } from './ingest.js';
import { sendToQueue } from './queue-sender.js';

const { logger, metrics, tracer } = createObservability('ingest');
const queueUrl = requireEnv('QUEUE_URL');
// Created once per container so warm invocations reuse connections.
const sqs = tracer.captureAWSv3Client(new SQSClient({}));

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  logger.addContext(context);
  try {
    const outcome = await ingest(decodeBody(event.body, event.isBase64Encoded), {
      send: (events, receivedAt) => sendToQueue(sqs, queueUrl, events, receivedAt),
      now: () => new Date(),
    });

    metrics.addMetric('EventsAccepted', MetricUnit.Count, outcome.accepted.length);
    metrics.addMetric('EventsRejected', MetricUnit.Count, outcome.rejectedCount);
    metrics.addMetric('EventsQueueFailed', MetricUnit.Count, outcome.failedCount);
    if (outcome.malformed) {
      metrics.addMetric('MalformedRequests', MetricUnit.Count, 1);
    }

    // Ids and types only: request bodies may carry player data and are never logged.
    logger.info('ingest complete', {
      statusCode: outcome.statusCode,
      accepted: outcome.accepted,
      rejected: outcome.rejectedCount,
      failed: outcome.failedCount,
    });

    return json(outcome.statusCode, outcome.body);
  } catch (error) {
    logger.error('ingest failed', error as Error);
    return json(500, { message: 'Internal error' });
  } finally {
    metrics.publishStoredMetrics();
  }
}
