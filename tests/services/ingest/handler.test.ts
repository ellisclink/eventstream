import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';

import { handler } from '../../../services/ingest/src/handler';
import { sampleEventJson } from '../../fixtures/events';

const sqsMock = mockClient(SQSClient);

const context = { functionName: 'ingest', awsRequestId: 'req-1' } as Context;

function apiEvent(body: string | null): APIGatewayProxyEvent {
  return { body, isBase64Encoded: false } as APIGatewayProxyEvent;
}

beforeEach(() => {
  sqsMock.reset();
  sqsMock.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
});

describe('ingest handler', () => {
  it('queues valid events and returns 202 JSON', async () => {
    const result = await handler(
      apiEvent(JSON.stringify({ events: [sampleEventJson('session_start')] })),
      context,
    );

    expect(result.statusCode).toBe(202);
    expect(result.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(result.body)).toEqual({ accepted: 1, rejected: [], failed: [] });
    expect(sqsMock.commandCalls(SendMessageBatchCommand)[0]?.args[0].input.QueueUrl).toBe(
      'https://sqs.test/queue',
    );
  });

  it('decodes base64 bodies', async () => {
    const raw = JSON.stringify({ events: [sampleEventJson('session_start')] });
    const result = await handler(
      { body: Buffer.from(raw).toString('base64'), isBase64Encoded: true } as APIGatewayProxyEvent,
      context,
    );
    expect(result.statusCode).toBe(202);
  });

  it('returns 400 for a missing body', async () => {
    const result = await handler(apiEvent(null), context);
    expect(result.statusCode).toBe(400);
  });
});
