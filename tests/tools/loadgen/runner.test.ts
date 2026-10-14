import { eventSchema } from '@eventstream/schema';

import { eventsEndpoint, parseCliArgs } from '../../../tools/loadgen/src/args';
import type { PostResult } from '../../../tools/loadgen/src/client';
import { EventGenerator } from '../../../tools/loadgen/src/generator';
import { Random } from '../../../tools/loadgen/src/random';
import { percentile, run } from '../../../tools/loadgen/src/runner';

function fakeClock() {
  let t = Date.parse('2026-10-13T12:00:00.000Z');
  return {
    now: () => new Date(t),
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

describe('run', () => {
  it('sends rate x duration events in batches and summarizes results', async () => {
    const clock = fakeClock();
    const rng = new Random(1);
    const post = jest.fn((events: unknown[]): Promise<PostResult> =>
      Promise.resolve({
        status: 202,
        accepted: events.length,
        rejected: 0,
        failed: 0,
        attempts: 1,
        latencyMs: 20,
      }),
    );

    const summary = await run(
      { rate: 100, durationSeconds: 5, batchSize: 25, invalidRatio: 0, maxInFlight: 4 },
      { generator: new EventGenerator(rng, 10), rng, post, ...clock },
    );

    expect(post).toHaveBeenCalledTimes(20);
    expect(summary).toMatchObject({ batches: 20, events: 500, accepted: 500, failed: 0 });
    expect(summary.statusCounts).toEqual({ '202': 20 });
    // 20 batches spaced 250 ms apart: the last one is due at 4.75 s.
    expect(summary.elapsedSeconds).toBeCloseTo(4.8, 0);
  });

  it('mixes in invalid events at roughly the requested ratio', async () => {
    const rng = new Random(2);
    let sent: unknown[] = [];
    await run(
      { rate: 1000, durationSeconds: 1, batchSize: 100, invalidRatio: 0.5, maxInFlight: 1 },
      {
        generator: new EventGenerator(rng, 10),
        rng,
        ...fakeClock(),
        post: (events) => {
          sent = sent.concat(events);
          return Promise.resolve({
            status: 202,
            accepted: 0,
            rejected: 0,
            failed: 0,
            attempts: 1,
            latencyMs: 1,
          });
        },
      },
    );
    const invalid = sent.filter((e) => !eventSchema.safeParse(e).success).length;
    expect(invalid / sent.length).toBeGreaterThan(0.35);
    expect(invalid / sent.length).toBeLessThan(0.65);
  });
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile([], 95)).toBe(0);
  });
});

describe('CLI args', () => {
  it('applies defaults and reads the key only from the environment', () => {
    const options = parseCliArgs([], {
      EVENTSTREAM_API_KEY: 'secret',
      EVENTSTREAM_API_URL: 'https://x/dev/',
    });
    expect(options).toMatchObject({
      rate: 50,
      durationSeconds: 30,
      batchSize: 25,
      apiKey: 'secret',
      url: 'https://x/dev/',
    });
  });

  it('rejects out-of-range values and unknown flags', () => {
    expect(() => parseCliArgs(['--batch-size', '500'], {})).toThrow(/batch-size/);
    expect(() => parseCliArgs(['--rate', 'fast'], {})).toThrow(/rate/);
    expect(() => parseCliArgs(['--api-key', 'oops'], {})).toThrow();
  });

  it('builds the /events endpoint from the CDK ApiUrl output', () => {
    expect(eventsEndpoint('https://abc.execute-api.eu-west-2.amazonaws.com/dev/')).toBe(
      'https://abc.execute-api.eu-west-2.amazonaws.com/dev/events',
    );
    expect(eventsEndpoint('https://h/dev/events')).toBe('https://h/dev/events');
  });
});
