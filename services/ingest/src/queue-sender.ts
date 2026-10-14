import {
  SendMessageBatchCommand,
  type SQSClient,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import type { QueuedEvent } from '@eventstream/schema';

import type { ValidEvent } from './validate-request.js';

/** SQS SendMessageBatch accepts at most 10 entries per call. */
export const SQS_BATCH_LIMIT = 10;

export interface SendResult {
  readonly sent: number[];
  readonly failed: number[];
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Queues events in batches of 10 and reports which request indexes failed. Entries that SQS
 * rejects inside an otherwise successful call are retried once, because those are usually
 * transient; a second failure is reported back so the client can retry.
 */
export async function sendToQueue(
  sqs: SQSClient,
  queueUrl: string,
  events: readonly ValidEvent[],
  receivedAt: Date,
): Promise<SendResult> {
  const sent: number[] = [];
  const failed: number[] = [];

  for (const group of chunk(events, SQS_BATCH_LIMIT)) {
    let pending = group.map((item) => toEntry(item, receivedAt));
    for (let attempt = 1; attempt <= 2 && pending.length > 0; attempt++) {
      try {
        const response = await sqs.send(
          new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: pending }),
        );
        const failedIds = new Set((response.Failed ?? []).map((f) => f.Id));
        sent.push(...pending.filter((e) => !failedIds.has(e.Id)).map((e) => Number(e.Id)));
        pending = pending.filter((e) => failedIds.has(e.Id));
      } catch {
        // Whole-call failure (throttling, network): the SDK already retried with backoff.
        break;
      }
    }
    failed.push(...pending.map((e) => Number(e.Id)));
  }

  return { sent: sent.sort((a, b) => a - b), failed: failed.sort((a, b) => a - b) };
}

function toEntry({ index, event }: ValidEvent, receivedAt: Date): SendMessageBatchRequestEntry {
  const body: QueuedEvent = { received_at: receivedAt.toISOString(), event };
  return {
    // The request index doubles as the batch entry id so failures map straight back.
    Id: String(index),
    MessageBody: JSON.stringify(body),
    MessageAttributes: {
      event_type: { DataType: 'String', StringValue: event.event_type },
    },
  };
}
