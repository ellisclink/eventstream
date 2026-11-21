import { FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';
import { DynamoDBDocumentClient, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';

import { handler } from '../../../services/processor/src/handler';
import { sampleEvent } from '../../fixtures/events';

const dbMock = mockClient(DynamoDBDocumentClient);
const firehoseMock = mockClient(FirehoseClient);
const context = { functionName: 'processor', awsRequestId: 'req-1' } as Context;

function sqsEvent(...bodies: string[]): SQSEvent {
  return {
    Records: bodies.map((body, i) => ({ messageId: `m${String(i)}`, body }) as SQSRecord),
  };
}

beforeEach(() => {
  dbMock.reset();
  dbMock.on(UpdateCommand).resolves({});
  dbMock.on(TransactWriteCommand).resolves({});
  firehoseMock.reset();
  firehoseMock.on(PutRecordBatchCommand).resolves({ FailedPutCount: 0, RequestResponses: [{}] });
});

describe('processor handler', () => {
  it('writes to the configured table and reports only bad messages', async () => {
    const good = JSON.stringify({
      received_at: '2026-10-13T10:00:00.000Z',
      event: sampleEvent('purchase'),
    });
    const result = await handler(sqsEvent(good, 'not json'), context);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    const tx = dbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(tx?.TransactItems?.[0]?.Put?.TableName).toBe('stats-test');
    const archived = firehoseMock.commandCalls(PutRecordBatchCommand)[0]?.args[0].input;
    expect(archived?.DeliveryStreamName).toBe('archive-test');
    expect(archived?.Records).toHaveLength(1);
  });
});
