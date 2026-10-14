import { queuedEventSchema, type QueuedEvent } from '@eventstream/schema';
import type { SQSBatchResponse, SQSRecord } from 'aws-lambda';

import type { GroupResult } from './stats-store.js';

export interface ProcessDeps {
  /** Applies all of one player's events from this batch; throws if they could not be applied. */
  readonly applyGroup: (events: QueuedEvent[]) => Promise<GroupResult>;
  /** Archives processed events; returns the event ids that could not be archived. */
  readonly archive?: (events: QueuedEvent[]) => Promise<string[]>;
  readonly onError?: (message: string, details: Record<string, unknown>) => void;
}

export interface BatchStats {
  applied: number;
  duplicates: number;
  invalid: number;
  failed: number;
  archiveFailed: number;
  /** Milliseconds between ingest accepting each event and this batch processing it. */
  delaysMs: number[];
}

export interface ProcessOutcome {
  readonly response: SQSBatchResponse;
  readonly stats: BatchStats;
}

interface Item {
  readonly messageId: string;
  readonly queued: QueuedEvent;
}

/**
 * Processes an SQS batch and reports per-message failures (ReportBatchItemFailures), so a
 * failed message is retried alone instead of forcing the whole batch to be redelivered.
 *
 * Events are grouped by player: each group becomes as few DynamoDB transactions as possible
 * (cheaper, and one player's item is never written by two of our own transactions at once).
 * Different players run in parallel.
 */
export async function processBatch(
  records: readonly SQSRecord[],
  deps: ProcessDeps,
  now: Date = new Date(),
): Promise<ProcessOutcome> {
  const stats: BatchStats = {
    applied: 0,
    duplicates: 0,
    invalid: 0,
    failed: 0,
    archiveFailed: 0,
    delaysMs: [],
  };
  const failures = new Set<string>();
  const processed: Item[] = [];
  const byPlayer = new Map<string, Item[]>();

  for (const record of records) {
    const queued = parseRecord(record);
    if (queued === undefined) {
      stats.invalid++;
      failures.add(record.messageId);
      deps.onError?.('invalid queue message', { messageId: record.messageId });
      continue;
    }
    const group = byPlayer.get(queued.event.player_id) ?? [];
    group.push({ messageId: record.messageId, queued });
    byPlayer.set(queued.event.player_id, group);
  }

  await Promise.all(
    [...byPlayer.values()].map(async (group) => {
      try {
        const result = await deps.applyGroup(group.map((item) => item.queued));
        stats.applied += result.applied.length;
        stats.duplicates += result.duplicates.length;
        for (const item of group) {
          stats.delaysMs.push(now.getTime() - Date.parse(item.queued.received_at));
          processed.push(item);
        }
      } catch (error) {
        // The whole group is retried. A failed transaction wrote nothing, and events that
        // committed in an earlier chunk are recognised as duplicates on redelivery, so the
        // DynamoDB counters stay exact; only these metrics drift slightly (such events count
        // as failed now and as duplicates later). Tradeoff of grouping: a non-conflict error
        // retries all of this player's events in the batch, not just one.
        stats.failed += group.length;
        for (const item of group) failures.add(item.messageId);
        deps.onError?.('failed to apply player events', {
          messageIds: group.map((i) => i.messageId),
          error: (error as Error).name,
        });
      }
    }),
  );

  if (deps.archive && processed.length > 0) {
    // Duplicates are archived again on purpose: if a previous attempt updated DynamoDB but
    // failed to archive, the retry is the only chance to fill that gap. Athena queries
    // de-duplicate by event_id.
    const failedIds = new Set(await deps.archive(processed.map((p) => p.queued)));
    for (const item of processed) {
      if (failedIds.has(item.queued.event.event_id)) {
        stats.archiveFailed++;
        failures.add(item.messageId);
      }
    }
  }

  return {
    response: { batchItemFailures: [...failures].map((itemIdentifier) => ({ itemIdentifier })) },
    stats,
  };
}

function parseRecord(record: SQSRecord): QueuedEvent | undefined {
  try {
    const result = queuedEventSchema.safeParse(JSON.parse(record.body));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
