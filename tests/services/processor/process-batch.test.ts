import type { QueuedEvent } from '@eventstream/schema';
import type { SQSRecord } from 'aws-lambda';

import { processBatch } from '../../../services/processor/src/process-batch';
import type { GroupResult } from '../../../services/processor/src/stats-store';
import { sampleEvent } from '../../fixtures/events';

const NOW = new Date('2026-10-13T10:00:05.000Z');

function record(messageId: string, body: unknown): SQSRecord {
  return {
    messageId,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  } as SQSRecord;
}

function queuedFor(playerId: string): QueuedEvent {
  return {
    received_at: '2026-10-13T10:00:00.000Z',
    event: sampleEvent('match_start', { player_id: playerId }),
  };
}

const allApplied = (events: QueuedEvent[]): Promise<GroupResult> =>
  Promise.resolve({ applied: events.map((e) => e.event.event_id), duplicates: [] });

describe('processBatch', () => {
  it('reports no failures when everything applies, and measures delay', async () => {
    const { response, stats } = await processBatch(
      [record('m1', queuedFor('a')), record('m2', queuedFor('b'))],
      { applyGroup: allApplied },
      NOW,
    );

    expect(response.batchItemFailures).toEqual([]);
    expect(stats).toMatchObject({ applied: 2, duplicates: 0, failed: 0 });
    expect(stats.delaysMs).toEqual([5000, 5000]);
  });

  it('hands each player’s events to applyGroup together', async () => {
    const applyGroup = jest.fn(allApplied);
    await processBatch(
      [record('1', queuedFor('a')), record('2', queuedFor('b')), record('3', queuedFor('a'))],
      { applyGroup },
    );
    const groups = applyGroup.mock.calls.map(([events]) => events.map((e) => e.event.player_id));
    expect(groups.sort()).toEqual([['a', 'a'], ['b']]);
  });

  it('counts duplicates as success, not failure', async () => {
    const { response, stats } = await processBatch([record('m1', queuedFor('a'))], {
      applyGroup: (events) =>
        Promise.resolve({ applied: [], duplicates: events.map((e) => e.event.event_id) }),
    });
    expect(response.batchItemFailures).toEqual([]);
    expect(stats.duplicates).toBe(1);
  });

  it('fails every message of a player group whose write failed, and only those', async () => {
    const { response, stats } = await processBatch(
      [
        record('m1', queuedFor('a')),
        record('m2', queuedFor('b')),
        record('m3', queuedFor('b')),
        record('m4', queuedFor('c')),
      ],
      {
        applyGroup: (events) =>
          events[0]?.event.player_id === 'b'
            ? Promise.reject(new Error('throttled'))
            : allApplied(events),
      },
    );
    expect(response.batchItemFailures.map((f) => f.itemIdentifier).sort()).toEqual(['m2', 'm3']);
    expect(stats.failed).toBe(2);
  });

  it('fails messages that are not valid queued events', async () => {
    const onError = jest.fn();
    const { response, stats } = await processBatch(
      [
        record('bad-json', '{oops'),
        record('bad-shape', { event: {} }),
        record('ok', queuedFor('a')),
      ],
      { applyGroup: allApplied, onError },
    );
    expect(response.batchItemFailures.map((f) => f.itemIdentifier).sort()).toEqual([
      'bad-json',
      'bad-shape',
    ]);
    expect(stats.invalid).toBe(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('runs different players in parallel', async () => {
    let active = 0;
    let peak = 0;
    const applyGroup = async (events: QueuedEvent[]) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return allApplied(events);
    };
    await processBatch([record('1', queuedFor('a')), record('2', queuedFor('b'))], { applyGroup });
    expect(peak).toBe(2);
  });

  it('fails messages whose events could not be archived', async () => {
    const a = queuedFor('a');
    const b = queuedFor('b');
    const archive = jest.fn(() => Promise.resolve([b.event.event_id]));
    const { response, stats } = await processBatch([record('m1', a), record('m2', b)], {
      applyGroup: allApplied,
      archive,
    });

    expect(archive).toHaveBeenCalledWith(expect.arrayContaining([a, b]));
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
    expect(stats.archiveFailed).toBe(1);
  });

  it('archives duplicates too, so a retry can fill an archive gap', async () => {
    const archive = jest.fn(() => Promise.resolve([]));
    await processBatch([record('m1', queuedFor('a'))], {
      applyGroup: (events) =>
        Promise.resolve({ applied: [], duplicates: events.map((e) => e.event.event_id) }),
      archive,
    });
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it('does not archive events whose group failed', async () => {
    const archive = jest.fn(() => Promise.resolve([]));
    await processBatch([record('m1', queuedFor('a'))], {
      applyGroup: () => Promise.reject(new Error('x')),
      archive,
    });
    expect(archive).not.toHaveBeenCalled();
  });
});
