import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { keys, type QueuedEvent } from '@eventstream/schema';

import { addExpression, aggregateDeltas, mergeCounters, type Counters } from './aggregate.js';

/**
 * How long a processed event id is remembered. Longer than SQS retention (4 days) plus DLQ
 * retention (14 days), so even a message redriven from the DLQ late is still recognised.
 */
export const DEDUPE_TTL_SECONDS = 30 * 24 * 3600;

/**
 * TransactWriteItems takes at most 100 items. A chunk of N events uses N dedupe markers +
 * 1 player item + up to N day items (normally 1), so 48 keeps the worst case under 100.
 */
export const MAX_EVENTS_PER_TRANSACTION = 48;

export interface RetryPolicy {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Every transaction also updates a shared DAY# item, so concurrent transactions (other
 * players, other processor invocations) can collide and DynamoDB cancels one with
 * TransactionConflict. That is contention, not failure: retry with jittered backoff before
 * giving up and letting SQS redeliver.
 */
export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 6,
  baseDelayMs: 25,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface GroupResult {
  /** Event ids counted by this call. */
  readonly applied: string[];
  /** Event ids already counted earlier (or repeated within the group). */
  readonly duplicates: string[];
}

/**
 * Applies one player's events exactly once, in as few transactions as possible.
 *
 * Each transaction holds one dedupe marker per event (Put with attribute_not_exists) plus the
 * player's and day's counters summed over all those events. All-or-nothing still holds: the
 * counters change if and only if every marker was new. When some markers already exist,
 * CancellationReasons says which, so those events are set aside as duplicates and the
 * transaction is rebuilt from the rest.
 *
 * Cost: a transactional write costs 2 write units per item, so batching N events for a
 * player turns 6N units into 2N + 4, which is the main saving over one transaction per event.
 */
export async function applyPlayerEvents(
  db: DynamoDBDocumentClient,
  tableName: string,
  events: readonly QueuedEvent[],
  now: Date,
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<GroupResult> {
  const applied: string[] = [];
  const duplicates: string[] = [];

  // The same event id twice in one group (client retry landing in the same batch) would make
  // DynamoDB reject the transaction for touching one item twice; treat the repeat as a duplicate.
  const unique: QueuedEvent[] = [];
  const seen = new Set<string>();
  for (const q of events) {
    if (seen.has(q.event.event_id)) duplicates.push(q.event.event_id);
    else {
      seen.add(q.event.event_id);
      unique.push(q);
    }
  }

  for (let i = 0; i < unique.length; i += MAX_EVENTS_PER_TRANSACTION) {
    const result = await applyChunk(
      db,
      tableName,
      unique.slice(i, i + MAX_EVENTS_PER_TRANSACTION),
      now,
      retry,
    );
    applied.push(...result.applied);
    duplicates.push(...result.duplicates);
  }

  // Bounds cover duplicates too: harmless, since min/max are idempotent, and it fills in a
  // bound whose write failed on an earlier attempt after the counters had committed.
  if (events.length > 0) {
    await updateBounds(db, tableName, events, retry);
  }
  return { applied, duplicates };
}

async function applyChunk(
  db: DynamoDBDocumentClient,
  tableName: string,
  chunk: readonly QueuedEvent[],
  now: Date,
  retry: RetryPolicy,
): Promise<GroupResult> {
  let pending = [...chunk];
  const duplicates: string[] = [];
  let conflicts = 0;

  while (pending.length > 0) {
    try {
      await db.send(
        new TransactWriteCommand({ TransactItems: buildTransaction(tableName, pending, now) }),
      );
      return { applied: pending.map((q) => q.event.event_id), duplicates };
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error;
      const reasons = error.CancellationReasons ?? [];

      // Items 0..pending.length-1 are the dedupe markers, in the same order as `pending`.
      const alreadySeen = new Set(
        pending
          .filter((_, idx) => reasons[idx]?.Code === 'ConditionalCheckFailed')
          .map((q) => q.event.event_id),
      );
      if (alreadySeen.size > 0) {
        duplicates.push(...alreadySeen);
        pending = pending.filter((q) => !alreadySeen.has(q.event.event_id));
        continue;
      }

      if (isConflict(error) && ++conflicts < retry.attempts) {
        await backoff(retry, conflicts);
        continue;
      }
      throw error;
    }
  }
  return { applied: [], duplicates };
}

function buildTransaction(tableName: string, events: readonly QueuedEvent[], now: Date) {
  const nowIso = now.toISOString();
  const expiresAt = Math.floor(now.getTime() / 1000) + DEDUPE_TTL_SECONDS;
  const playerId = events[0]?.event.player_id ?? '';

  let playerCounters: Counters = {};
  const dayCounters = new Map<string, Counters>();
  for (const { event } of events) {
    const deltas = aggregateDeltas(event);
    playerCounters = mergeCounters(playerCounters, deltas.player);
    dayCounters.set(deltas.date, mergeCounters(dayCounters.get(deltas.date) ?? {}, deltas.day));
  }

  return [
    ...events.map(({ event, received_at }) => ({
      Put: {
        TableName: tableName,
        Item: { ...keys.event(event.event_id), received_at, expires_at: expiresAt },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    })),
    {
      Update: counterUpdate(tableName, keys.player(playerId), playerCounters, {
        player_id: playerId,
        updated_at: nowIso,
      }),
    },
    ...[...dayCounters].map(([date, counters]) => ({
      Update: counterUpdate(tableName, keys.day(date), counters, { date, updated_at: nowIso }),
    })),
  ];
}

function counterUpdate(
  tableName: string,
  key: Record<string, string>,
  counters: Counters,
  set: Record<string, string>,
) {
  const add = addExpression(counters);
  const names: Record<string, string> = { ...add.names };
  const values: Record<string, string | number> = { ...add.values };
  const assignments: string[] = [];

  Object.entries(set).forEach(([attr, value], i) => {
    names[`#s${String(i)}`] = attr;
    values[`:s${String(i)}`] = value;
    assignments.push(`#s${String(i)} = :s${String(i)}`);
  });

  return {
    TableName: tableName,
    Key: key,
    UpdateExpression: `${add.expression} SET ${assignments.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/**
 * One min/max write per attribute per player per batch, instead of per event. Timestamps are
 * normalised to UTC so DynamoDB's string comparison orders them correctly.
 */
async function updateBounds(
  db: DynamoDBDocumentClient,
  tableName: string,
  events: readonly QueuedEvent[],
  retry: RetryPolicy,
): Promise<void> {
  const key = keys.player(events[0]?.event.player_id ?? '');
  const times = events.map((q) => new Date(q.event.occurred_at).toISOString()).sort();
  const levels = events.flatMap((q) =>
    q.event.event_type === 'level_up' ? [q.event.payload.new_level] : [],
  );

  const writes = [
    setBound(db, tableName, key, 'last_event_at', times.at(-1) ?? '', 'max', retry),
    setBound(db, tableName, key, 'first_seen_at', times[0] ?? '', 'min', retry),
  ];
  if (levels.length > 0) {
    writes.push(setBound(db, tableName, key, 'level', Math.max(...levels), 'max', retry));
  }
  await Promise.all(writes);
}

/**
 * "attr = max(attr, value)" (or min) isn't expressible as an ADD, so it is a conditional
 * write outside the transaction. Max and min are idempotent and order-independent, so it is
 * safe to repeat for duplicates and out-of-order events; a failed condition just means the
 * stored value already wins.
 */
async function setBound(
  db: DynamoDBDocumentClient,
  tableName: string,
  key: Record<string, string>,
  attribute: string,
  value: string | number,
  bound: 'max' | 'min',
  retry: RetryPolicy,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.send(
        new UpdateCommand({
          TableName: tableName,
          Key: key,
          UpdateExpression: 'SET #a = :v',
          ConditionExpression: `attribute_not_exists(#a) OR #a ${bound === 'max' ? '<' : '>'} :v`,
          ExpressionAttributeNames: { '#a': attribute },
          ExpressionAttributeValues: { ':v': value },
        }),
      );
      return;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return;
      if (!isConflict(error) || attempt >= retry.attempts) throw error;
      await backoff(retry, attempt);
    }
  }
}

/** Full jitter: a random wait up to an exponentially growing cap (max 1 s), so writers that
 * collided don't collide again in lockstep. */
function backoff(policy: RetryPolicy, attempt: number): Promise<void> {
  const cap = Math.min(1000, policy.baseDelayMs * 2 ** (attempt - 1));
  return policy.sleep(Math.random() * cap);
}

/** A transaction cancelled by a concurrent write, or a single write blocked by a transaction. */
export function isConflict(error: unknown): boolean {
  if (error instanceof TransactionCanceledException) {
    return (error.CancellationReasons ?? []).some((r) => r.Code === 'TransactionConflict');
  }
  return error instanceof Error && error.name === 'TransactionConflictException';
}
