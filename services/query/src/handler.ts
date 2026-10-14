import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

import { requireEnv } from '../../shared/src/env.js';
import { json } from '../../shared/src/http.js';
import { createObservability } from '../../shared/src/observability.js';
import { query } from './query.js';
import { dynamoStatsReader } from './stats-reader.js';

const { logger, metrics, tracer } = createObservability('query');
const reader = dynamoStatsReader(
  DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({}))),
  requireEnv('TABLE_NAME'),
);

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  logger.addContext(context);
  try {
    const response = await query(event, reader);
    metrics.addMetric(`Query${String(response.statusCode)}`, MetricUnit.Count, 1);
    logger.info('query', { resource: event.resource, statusCode: response.statusCode });
    return response;
  } catch (error) {
    logger.error('query failed', error as Error);
    metrics.addMetric('Query500', MetricUnit.Count, 1);
    return json(500, { message: 'Internal error' });
  } finally {
    metrics.publishStoredMetrics();
  }
}
