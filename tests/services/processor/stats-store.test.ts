import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { QueuedEvent } from '@eventstream/schema';
import { mockClient } from 'aws-sdk-client-mock';

import {
  DEDUPE_TTL_SECONDS,
  MAX_EVENTS_PER_TRANSACTION,
  applyPlayerEvents,
} from '../../../services/processor/src/stats-store';
import { sampleEvent } from '../../fixtures/events';

const dbMock = mockClient(DynamoDBDocumentClient);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const NOW = new Date('2026-10-13T10:00:00.000Z');
const sleep = jest.fn(() => Promise.resolve());
const fastRetry = { attempts: 4, baseDelayMs: 1, sleep };

function queued(event: QueuedEvent['event'] = sampleEvent('match_end')): QueuedEvent {
  return { received_at: '2026-10-13T09:59:59.000Z', event };
}

function cancelled(...codes: string[]): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

interface BoundUpdate {
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

function boundUpdates(): Record<string, BoundUpdate> {
  const updates = dbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input as BoundUpdate);
  return Object.fromEntries(updates.map((u) => [u.ExpressionAttributeNames?.['#a'] ?? '', u]));
}

const transactions = () =>
  dbMock.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems ?? []);

beforeEach(() => {
  dbMock.reset();
  sleep.mockClear();
  dbMock.on(TransactWriteCommand).resolves({});
  dbMock.on(UpdateCommand).resolves({});
});

describe('applyPlayerEvents', () => {
  it('writes one marker per event plus one summed player and day update', async () => {
    const events = [queued(), queued(), queued(sampleEvent('purchase'))];
    const result = await applyPlayerEvents(db, 'stats', events, NOW, fastRetry);

    expect(result.applied).toHaveLength(3);
    const items = transactions()[0] ?? [];
    expect(items).toHaveLength(5);
    expect(
      items.slice(0, 3).every((i) => i.Put?.ConditionExpression === 'attribute_not_exists(pk)'),
    ).toBe(true);
    expect(items[0]?.Put?.Item).toMatchObject({
      pk: `EVENT#${events[0]?.event.event_id ?? ''}`,
      expires_at: NOW.getTime() / 1000 + DEDUPE_TTL_SECONDS,
    });

    const player = items[3]?.Update;
    expect(player?.Key).toEqual({ pk: 'PLAYER#player-123', sk: 'STATS' });
    const names = player?.ExpressionAttributeNames ?? {};
    const placeholder = Object.entries(names).find(([, v]) => v === 'events')?.[0] ?? '';
    expect(player?.ExpressionAttributeValues?.[placeholder.replace('#', ':')]).toBe(3);
    expect(items[4]?.Update?.Key).toEqual({ pk: 'DAY#2026-10-12', sk: 'TOTALS' });
  });

  it('writes one day update per distinct UTC date', async () => {
    const late = queued(sampleEvent('level_up', { occurred_at: '2026-10-13T01:00:00.000Z' }));
    await applyPlayerEvents(db, 'stats', [queued(), late], NOW, fastRetry);
    const dayKeys = (transactions()[0] ?? [])
      .map((i) => i.Update?.Key?.['pk'] as string | undefined)
      .filter((pk) => pk?.startsWith('DAY#'));
    expect(dayKeys).toEqual(['DAY#2026-10-12', 'DAY#2026-10-13']);
  });

  it('drops already-counted events by cancellation index and commits the rest', async () => {
    const events = [queued(), queued(), queued()];
    dbMock
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled('None', 'ConditionalCheckFailed', 'None', 'None', 'None'))
      .resolves({});

    const result = await applyPlayerEvents(db, 'stats', events, NOW, fastRetry);
    expect(result.duplicates).toEqual([events[1]?.event.event_id]);
    expect(result.applied).toEqual([events[0]?.event.event_id, events[2]?.event.event_id]);
    expect(transactions()[1]).toHaveLength(4);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns everything as duplicate when every marker exists', async () => {
    dbMock
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled('ConditionalCheckFailed', 'None', 'None'));
    const result = await applyPlayerEvents(db, 'stats', [queued()], NOW, fastRetry);
    expect(result.applied).toEqual([]);
    expect(result.duplicates).toHaveLength(1);
    expect(transactions()).toHaveLength(1);
  });

  it('treats a repeated id within the group as a duplicate without sending it twice', async () => {
    const event = queued();
    const result = await applyPlayerEvents(db, 'stats', [event, event], NOW, fastRetry);
    expect(result).toEqual({ applied: [event.event.event_id], duplicates: [event.event.event_id] });
    expect(transactions()[0]).toHaveLength(3);
  });

  it('splits large groups into transactions under the 100-item limit', async () => {
    const events = Array.from({ length: MAX_EVENTS_PER_TRANSACTION + 5 }, () => queued());
    await applyPlayerEvents(db, 'stats', events, NOW, fastRetry);
    expect(transactions().map((t) => t.length)).toEqual([MAX_EVENTS_PER_TRANSACTION + 2, 7]);
  });

  it('stays under 100 items even if every event is on a different day', async () => {
    const events = Array.from({ length: MAX_EVENTS_PER_TRANSACTION }, (_, i) =>
      queued(
        sampleEvent('level_up', { occurred_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }),
      ),
    );
    await applyPlayerEvents(db, 'stats', events, NOW, fastRetry);
    expect(transactions()[0]?.length).toBeLessThanOrEqual(100);
  });

  it('retries a transaction cancelled by a concurrent write, then applies it', async () => {
    dbMock
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled('None', 'None', 'TransactionConflict'))
      .resolves({});
    const result = await applyPlayerEvents(db, 'stats', [queued()], NOW, fastRetry);
    expect(result.applied).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget so SQS can redeliver', async () => {
    dbMock.on(TransactWriteCommand).rejects(cancelled('None', 'None', 'TransactionConflict'));
    await expect(applyPlayerEvents(db, 'stats', [queued()], NOW, fastRetry)).rejects.toThrow(
      TransactionCanceledException,
    );
    expect(transactions()).toHaveLength(4);
  });

  it('does not retry other errors', async () => {
    dbMock.on(TransactWriteCommand).rejects(new Error('ValidationException'));
    await expect(applyPlayerEvents(db, 'stats', [queued()], NOW, fastRetry)).rejects.toThrow(
      'ValidationException',
    );
    expect(transactions()).toHaveLength(1);
  });

  it('writes min/max bounds once per group, normalised to UTC', async () => {
    const events = [
      queued(sampleEvent('level_up', { occurred_at: '2026-10-12T20:30:00+02:00' })),
      queued(
        sampleEvent('level_up', {
          occurred_at: '2026-10-12T19:00:00.000Z',
          payload: { new_level: 9 },
        }),
      ),
      queued(sampleEvent('purchase', { occurred_at: '2026-10-12T17:00:00.000Z' })),
    ];
    await applyPlayerEvents(db, 'stats', events, NOW, fastRetry);

    const bounds = boundUpdates();
    expect(dbMock.commandCalls(UpdateCommand)).toHaveLength(3);
    expect(bounds['last_event_at']?.ExpressionAttributeValues).toEqual({
      ':v': '2026-10-12T19:00:00.000Z',
    });
    expect(bounds['first_seen_at']?.ExpressionAttributeValues).toEqual({
      ':v': '2026-10-12T17:00:00.000Z',
    });
    expect(bounds['level']?.ExpressionAttributeValues).toEqual({ ':v': 9 });
    expect(bounds['level']?.ConditionExpression).toBe('attribute_not_exists(#a) OR #a < :v');
    expect(bounds['first_seen_at']?.ConditionExpression).toContain('>');
  });

  it('skips the level write when there is no level_up', async () => {
    await applyPlayerEvents(db, 'stats', [queued(sampleEvent('purchase'))], NOW, fastRetry);
    expect(Object.keys(boundUpdates()).sort()).toEqual(['first_seen_at', 'last_event_at']);
  });

  it('treats a lower bound as already satisfied', async () => {
    dbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'lower', $metadata: {} }));
    await expect(applyPlayerEvents(db, 'stats', [queued()], NOW, fastRetry)).resolves.toBeDefined();
  });

  it('retries a bound write blocked by an in-flight transaction', async () => {
    const conflict = Object.assign(new Error('conflict'), { name: 'TransactionConflictException' });
    dbMock.on(UpdateCommand).rejectsOnce(conflict).resolves({});
    await expect(applyPlayerEvents(db, 'stats', [queued()], NOW, fastRetry)).resolves.toBeDefined();
  });
});
