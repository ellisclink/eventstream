import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { queuedEventSchema } from '@eventstream/schema';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

import { chunk, sendToQueue } from '../../../services/ingest/src/queue-sender';
import type { ValidEvent } from '../../../services/ingest/src/validate-request';
import { sampleEvent } from '../../fixtures/events';

const sqsMock = mockClient(SQSClient);
const sqs = new SQSClient({});
const RECEIVED = new Date('2026-10-13T10:00:00.000Z');

function validEvents(count: number): ValidEvent[] {
  return Array.from({ length: count }, (_, index) => ({ index, event: sampleEvent('level_up') }));
}

beforeEach(() => sqsMock.reset());

describe('chunk', () => {
  it('splits into groups of at most the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
  });
});

describe('sendToQueue', () => {
  it('sends 25 events as 3 batches and wraps each in a queued envelope', async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });

    const result = await sendToQueue(sqs, 'https://queue', validEvents(25), RECEIVED);

    expect(result).toEqual({ sent: [...Array(25).keys()], failed: [] });
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageBatchCommand, 3);

    const firstCall = sqsMock.commandCalls(SendMessageBatchCommand)[0];
    const entry = firstCall?.args[0].input.Entries?.[0];
    const parsed = queuedEventSchema.parse(JSON.parse(entry?.MessageBody ?? ''));
    expect(parsed.received_at).toBe(RECEIVED.toISOString());
    expect(entry?.MessageAttributes?.['event_type']?.StringValue).toBe('level_up');
  });

  it('retries entries SQS reported as failed, once', async () => {
    sqsMock
      .on(SendMessageBatchCommand)
      .resolvesOnce({
        Failed: [{ Id: '1', Code: 'InternalError', SenderFault: false }],
        Successful: [],
      })
      .resolvesOnce({ Failed: [], Successful: [] });

    const result = await sendToQueue(sqs, 'https://queue', validEvents(3), RECEIVED);

    expect(result).toEqual({ sent: [0, 1, 2], failed: [] });
    const retry = sqsMock.commandCalls(SendMessageBatchCommand)[1];
    expect(retry?.args[0].input.Entries?.map((e) => e.Id)).toEqual(['1']);
  });

  it('reports entries that fail twice', async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({
      Failed: [{ Id: '2', Code: 'InternalError', SenderFault: false }],
      Successful: [],
    });

    const result = await sendToQueue(sqs, 'https://queue', validEvents(3), RECEIVED);
    expect(result).toEqual({ sent: [0, 1], failed: [2] });
  });

  it('reports a whole batch as failed when the call throws', async () => {
    sqsMock.on(SendMessageBatchCommand).rejects(new Error('throttled'));

    const result = await sendToQueue(sqs, 'https://queue', validEvents(12), RECEIVED);
    expect(result.sent).toEqual([]);
    expect(result.failed).toHaveLength(12);
  });
});
