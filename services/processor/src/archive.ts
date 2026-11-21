import { PutRecordBatchCommand, type FirehoseClient } from '@aws-sdk/client-firehose';
import type { QueuedEvent } from '@eventstream/schema';

import { utcDate } from './aggregate.js';

/** PutRecordBatch limits: 500 records and 4 MiB per call. */
export const FIREHOSE_MAX_RECORDS = 500;
export const FIREHOSE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * One row in the Parquet archive. It must match the Glue table columns, because Firehose
 * converts JSON to Parquet using that schema. The payload stays a JSON string, so one table
 * holds every event type and future schema versions without a migration; Athena reads it
 * with json_extract_scalar.
 */
export interface ArchiveRecord {
  readonly event_id: string;
  readonly event_type: string;
  readonly schema_version: number;
  readonly player_id: string;
  readonly occurred_at: string;
  readonly event_date: string;
  readonly received_at: string;
  readonly payload: string;
}

export function toArchiveRecord({ event, received_at }: QueuedEvent): ArchiveRecord {
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    schema_version: event.schema_version,
    player_id: event.player_id,
    occurred_at: new Date(event.occurred_at).toISOString(),
    event_date: utcDate(event.occurred_at),
    received_at,
    payload: JSON.stringify(event.payload),
  };
}

/** Splits records so each batch stays inside both Firehose limits. */
export function batchForFirehose(lines: readonly { id: string; data: Uint8Array }[]) {
  const batches: { id: string; data: Uint8Array }[][] = [];
  let current: { id: string; data: Uint8Array }[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (
      current.length === FIREHOSE_MAX_RECORDS ||
      bytes + line.data.byteLength > FIREHOSE_MAX_BYTES
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(line);
    bytes += line.data.byteLength;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Sends events to Firehose and returns the event ids that were not accepted. Firehose can
 * reject single records inside a successful call (FailedPutCount), so the per-record
 * responses are checked rather than just the call result.
 */
export async function sendToArchive(
  firehose: FirehoseClient,
  deliveryStreamName: string,
  events: readonly QueuedEvent[],
): Promise<string[]> {
  const encoder = new TextEncoder();
  const lines = events.map((q) => ({
    id: q.event.event_id,
    // Newline-delimited so the raw error output in S3 stays one record per line.
    data: encoder.encode(`${JSON.stringify(toArchiveRecord(q))}\n`),
  }));

  const failed: string[] = [];
  for (const batch of batchForFirehose(lines)) {
    try {
      const result = await firehose.send(
        new PutRecordBatchCommand({
          DeliveryStreamName: deliveryStreamName,
          Records: batch.map((l) => ({ Data: l.data })),
        }),
      );
      result.RequestResponses?.forEach((response, i) => {
        const line = batch[i];
        if (response.ErrorCode !== undefined && line !== undefined) failed.push(line.id);
      });
    } catch {
      failed.push(...batch.map((l) => l.id));
    }
  }
  return failed;
}
