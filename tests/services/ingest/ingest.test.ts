import { ingest, type IngestDeps } from '../../../services/ingest/src/ingest';
import { sampleEventJson } from '../../fixtures/events';

const now = () => new Date('2026-10-13T10:00:00.000Z');

function deps(failIndexes: number[] = []): IngestDeps & { send: jest.Mock } {
  return {
    now,
    send: jest.fn((events: readonly { index: number }[]) =>
      Promise.resolve({
        sent: events.map((e) => e.index).filter((i) => !failIndexes.includes(i)),
        failed: failIndexes,
      }),
    ),
  };
}

const body = (events: unknown[]) => JSON.stringify({ events });

describe('ingest', () => {
  it('returns 202 with counts when events are queued', async () => {
    const d = deps();
    const result = await ingest(body([sampleEventJson('purchase'), { bad: 1 }]), d);

    expect(result.statusCode).toBe(202);
    expect(result.body).toMatchObject({ accepted: 1, failed: [] });
    expect(result.rejectedCount).toBe(1);
    expect(result.accepted[0]?.event_type).toBe('purchase');
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it('returns 400 and never touches the queue when nothing is valid', async () => {
    const d = deps();
    const result = await ingest(body([{ bad: 1 }]), d);

    expect(result.statusCode).toBe(400);
    expect(d.send).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed body', async () => {
    const result = await ingest('not json', deps());
    expect(result).toMatchObject({ statusCode: 400, malformed: true });
  });

  it('returns 503 when every valid event failed to queue', async () => {
    const result = await ingest(body([sampleEventJson('level_up')]), deps([0]));
    expect(result.statusCode).toBe(503);
    expect(result.body).toMatchObject({ accepted: 0, failed: [0] });
  });

  it('returns 202 and lists failed indexes on partial queue failure', async () => {
    const events = [sampleEventJson('level_up'), sampleEventJson('level_up')];
    const result = await ingest(body(events), deps([1]));

    expect(result.statusCode).toBe(202);
    expect(result.body).toMatchObject({ accepted: 1, failed: [1] });
  });
});

describe('request size cap', () => {
  it('returns 413 for bodies over 1 MiB without parsing or queueing', async () => {
    const d = deps();
    const huge = JSON.stringify({ events: [{ pad: 'x'.repeat(1024 * 1024) }] });
    const result = await ingest(huge, d);
    expect(result.statusCode).toBe(413);
    expect(d.send).not.toHaveBeenCalled();
  });
});
