import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { QueuedEvent } from '@eventstream/schema';
import type { SQSRecord } from 'aws-lambda';

import { processBatch } from '../../../services/processor/src/process-batch';
import { applyPlayerEvents, type RetryPolicy } from '../../../services/processor/src/stats-store';
import { EventGenerator } from '../../../tools/loadgen/src/generator';
import { Random } from '../../../tools/loadgen/src/random';

type Item = Record<string, unknown>;
type Values = Record<string, unknown>;
type Names = Record<string, string>;

/**
 * Minimal in-memory DynamoDB that understands exactly the expressions stats-store builds
 * (ADD, SET, attribute_not_exists, min/max conditions) and applies a transaction
 * all-or-nothing, reporting cancellation reasons per item like the real service. It lets
 * the test check the real outcome, aggregate values, not just which commands were sent.
 */
class FakeTable {
  readonly items = new Map<string, Item>();
  failNextTransactions = 0;
  writeUnits = 0;

  private key(k: Item): string {
    return `${String(k['pk'])}|${String(k['sk'])}`;
  }

  client(): DynamoDBDocumentClient {
    return {
      send: (command: unknown) => {
        if (command instanceof TransactWriteCommand) return this.transact(command);
        if (command instanceof UpdateCommand) return this.conditionalBound(command);
        throw new Error('unsupported command');
      },
    } as unknown as DynamoDBDocumentClient;
  }

  private transact(command: TransactWriteCommand): Promise<object> {
    const ops = command.input.TransactItems ?? [];
    // DynamoDB rejects these outright (ValidationException) before evaluating anything.
    const touched = ops.map((op) => this.key((op.Put?.Item ?? op.Update?.Key) as Item));
    if (ops.length > 100 || new Set(touched).size !== touched.length) {
      return Promise.reject(new Error('ValidationException: invalid transaction'));
    }
    if (this.failNextTransactions > 0) {
      this.failNextTransactions--;
      return Promise.reject(new Error('simulated network failure'));
    }
    const reasons = ops.map((op) =>
      op.Put && this.items.has(this.key(op.Put.Item as Item)) ? 'ConditionalCheckFailed' : 'None',
    );
    if (reasons.includes('ConditionalCheckFailed')) {
      // Charged conservatively: assume a cancelled transaction still consumes its write units.
      this.writeUnits += 2 * ops.length;
      return Promise.reject(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: reasons.map((Code) => ({ Code })),
        }),
      );
    }
    this.writeUnits += 2 * ops.length;
    for (const op of ops) {
      if (op.Put) this.items.set(this.key(op.Put.Item as Item), { ...(op.Put.Item as Item) });
      if (op.Update) {
        const u = op.Update;
        const id = this.key(u.Key as Item);
        const item: Item = { ...(this.items.get(id) ?? (u.Key as Item)) };
        applyUpdate(
          item,
          u.UpdateExpression ?? '',
          u.ExpressionAttributeNames ?? {},
          u.ExpressionAttributeValues ?? {},
        );
        this.items.set(id, item);
      }
    }
    return Promise.resolve({});
  }

  private conditionalBound(command: UpdateCommand): Promise<object> {
    this.writeUnits += 1;
    const id = this.key(command.input.Key as Item);
    const item: Item = { ...(this.items.get(id) ?? (command.input.Key as Item)) };
    const attr = command.input.ExpressionAttributeNames?.['#a'] ?? '';
    const value = command.input.ExpressionAttributeValues?.[':v'] as string | number;
    const current = item[attr] as string | number | undefined;
    const isMax = command.input.ConditionExpression?.includes('<') ?? false;
    if (current === undefined || (isMax ? current < value : current > value)) {
      item[attr] = value;
      this.items.set(id, item);
    }
    return Promise.resolve({});
  }

  get(pk: string, sk: string): Item | undefined {
    return this.items.get(`${pk}|${sk}`);
  }
}

function applyUpdate(item: Item, expression: string, names: Names, values: Values): void {
  const [, add = '', set = ''] = /^ADD (.*?)(?: SET (.*))?$/.exec(expression) ?? [];
  for (const part of add.split(', ').filter(Boolean)) {
    const [name = '', value = ''] = part.split(' ');
    const attr = names[name] ?? name;
    item[attr] = ((item[attr] as number | undefined) ?? 0) + (values[value] as number);
  }
  for (const part of set.split(', ').filter(Boolean)) {
    const [name = '', rhs = ''] = part.split(' = ');
    item[names[name] ?? name] = values[rhs];
  }
}

const noWait: RetryPolicy = { attempts: 3, baseDelayMs: 0, sleep: () => Promise.resolve() };

function stream(count: number, seed: number, players = 8): QueuedEvent[] {
  const generator = new EventGenerator(new Random(seed), players);
  return Array.from({ length: count }, (_, i) => ({
    received_at: '2026-10-13T10:00:00.000Z',
    event: generator.next(new Date(Date.UTC(2026, 9, 13, 10, 0, i))),
  }));
}

/** Delivers events in SQS-sized batches through the real batch processor. */
async function deliver(
  table: FakeTable,
  events: QueuedEvent[],
  batchSize = 100,
): Promise<string[]> {
  const db = table.client();
  const failed: string[] = [];
  for (let i = 0; i < events.length; i += batchSize) {
    const records = events
      .slice(i, i + batchSize)
      .map((q, j) => ({ messageId: String(i + j), body: JSON.stringify(q) }) as SQSRecord);
    const { response } = await processBatch(records, {
      applyGroup: (group) =>
        applyPlayerEvents(db, 'stats', group, new Date('2026-10-13T11:00:00Z'), noWait),
    });
    failed.push(...response.batchItemFailures.map((f) => f.itemIdentifier));
  }
  return failed;
}

function aggregates(table: FakeTable): Item[] {
  return [...table.items.entries()]
    .filter(([k]) => !k.startsWith('EVENT#'))
    .map(([, v]) =>
      // updated_at is wall-clock processing time, so it legitimately differs between runs.
      Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'updated_at')),
    )
    .sort((a, b) => String(a['pk']).localeCompare(String(b['pk'])));
}

describe('exactly-once aggregates', () => {
  const events = stream(400, 11);

  it('gives the same aggregates when every event is delivered twice, shuffled', async () => {
    const once = new FakeTable();
    await deliver(once, events);

    const twice = new FakeTable();
    const rng = new Random(3);
    await deliver(
      twice,
      [...events, ...events].sort(() => rng.next() - 0.5),
    );

    expect(aggregates(twice)).toEqual(aggregates(once));
  });

  it('handles batches that mix new events with already-counted ones', async () => {
    const reference = new FakeTable();
    await deliver(reference, events);

    const mixed = new FakeTable();
    await deliver(mixed, events.slice(0, 150));
    await deliver(mixed, events);
    expect(aggregates(mixed)).toEqual(aggregates(reference));
  });

  it('converges after failed transactions are redelivered', async () => {
    const reference = new FakeTable();
    await deliver(reference, events);

    const flaky = new FakeTable();
    flaky.failNextTransactions = 5;
    const failedIds = new Set(await deliver(flaky, events));
    expect(failedIds.size).toBeGreaterThan(0);
    await deliver(
      flaky,
      events.filter((_, i) => failedIds.has(String(i))),
    );

    expect(aggregates(flaky)).toEqual(aggregates(reference));
  });

  it('converges when a later chunk of a large player group fails after an earlier one committed', async () => {
    // One player, 100 events in one batch: split into 48 + 48 + 4 event transactions.
    const busy = stream(100, 21, 1);
    const reference = new FakeTable();
    await deliver(reference, busy);

    const table = new FakeTable();
    const inner = table.client();
    const realSend = (command: unknown) =>
      inner.send(command as Parameters<typeof inner.send>[0]) as Promise<object>;
    let call = 0;
    const failSecond = {
      send: (command: unknown) => {
        if (command instanceof TransactWriteCommand && ++call === 2) {
          return Promise.reject(new Error('simulated failure on chunk 2'));
        }
        return realSend(command);
      },
    } as unknown as DynamoDBDocumentClient;

    const records = busy.map(
      (q, i) => ({ messageId: String(i), body: JSON.stringify(q) }) as SQSRecord,
    );
    const first = await processBatch(records, {
      applyGroup: (group) => applyPlayerEvents(failSecond, 'stats', group, new Date(), noWait),
    });
    expect(first.response.batchItemFailures).toHaveLength(100);

    const failed = await deliver(table, busy); // SQS redelivers the whole group
    expect(failed).toEqual([]);
    expect(aggregates(table)).toEqual(aggregates(reference));
  });

  it('counts the same event repeated in one batch only once', async () => {
    const [first] = events;
    if (!first) throw new Error('fixture');
    const table = new FakeTable();
    await deliver(table, [first, first, first]);
    expect(table.get(`PLAYER#${first.event.player_id}`, 'STATS')?.['events']).toBe(1);
  });

  it('keeps the highest level even when level_up events arrive out of order', async () => {
    const levelUps = events.filter((q) => q.event.event_type === 'level_up');
    expect(levelUps.length).toBeGreaterThan(2);

    const table = new FakeTable();
    await deliver(table, [...levelUps].reverse(), 3);
    for (const q of levelUps) {
      const max = Math.max(
        ...levelUps
          .filter((l) => l.event.player_id === q.event.player_id)
          .map((l) => (l.event.event_type === 'level_up' ? l.event.payload.new_level : 0)),
      );
      expect(table.get(`PLAYER#${q.event.player_id}`, 'STATS')?.['level']).toBe(max);
    }
  });

  it('uses well under the ~8.3 write units per event of one transaction per event', async () => {
    const table = new FakeTable();
    await deliver(table, stream(1000, 5, 20));
    expect(table.writeUnits / 1000).toBeLessThan(5);
  });
});
