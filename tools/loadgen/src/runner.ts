import { corrupt, type EventGenerator } from './generator.js';
import type { PostResult } from './client.js';
import type { Random } from './random.js';

export interface RunOptions {
  /** Target events per second. */
  readonly rate: number;
  readonly durationSeconds: number;
  readonly batchSize: number;
  /** Fraction of events deliberately broken, 0..1. */
  readonly invalidRatio: number;
  /** Batches allowed in flight at once; protects the client machine and the API. */
  readonly maxInFlight: number;
}

export interface RunDeps {
  readonly generator: EventGenerator;
  readonly rng: Random;
  readonly post: (events: unknown[]) => Promise<PostResult>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onProgress?: (summary: RunSummary) => void;
}

export interface RunSummary {
  readonly batches: number;
  readonly events: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly failed: number;
  readonly retriedBatches: number;
  readonly statusCounts: Record<string, number>;
  readonly latencyMs: { p50: number; p95: number; p99: number; max: number };
  readonly elapsedSeconds: number;
  readonly eventsPerSecond: number;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

export function summarize(
  results: readonly PostResult[],
  batchSizes: readonly number[],
  elapsedMs: number,
): RunSummary {
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const statusCounts: Record<string, number> = {};
  for (const r of results) {
    const key = String(r.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  const events = batchSizes.reduce((a, b) => a + b, 0);
  const elapsedSeconds = elapsedMs / 1000;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    batches: results.length,
    events,
    accepted: results.reduce((a, r) => a + r.accepted, 0),
    rejected: results.reduce((a, r) => a + r.rejected, 0),
    failed: results.reduce((a, r) => a + r.failed, 0),
    retriedBatches: results.filter((r) => r.attempts > 1).length,
    statusCounts,
    latencyMs: {
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies.at(-1) ?? 0),
    },
    elapsedSeconds: round(elapsedSeconds),
    eventsPerSecond: elapsedSeconds > 0 ? round(events / elapsedSeconds) : 0,
  };
}

/**
 * Sends batches on a fixed schedule (open-loop), so a slow API shows up as rising latency
 * and in-flight batches instead of silently lowering the offered load.
 */
export async function run(options: RunOptions, deps: RunDeps): Promise<RunSummary> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = (1000 * options.batchSize) / options.rate;
  const totalBatches = Math.max(
    1,
    Math.round((options.rate * options.durationSeconds) / options.batchSize),
  );

  const results: PostResult[] = [];
  const batchSizes: number[] = [];
  const inFlight = new Set<Promise<void>>();
  const startedAt = now().getTime();

  for (let b = 0; b < totalBatches; b++) {
    const due = startedAt + b * intervalMs;
    const wait = due - now().getTime();
    if (wait > 0) await sleep(wait);
    while (inFlight.size >= options.maxInFlight) {
      await Promise.race(inFlight);
    }

    const batch: unknown[] = Array.from({ length: options.batchSize }, () => {
      const event = deps.generator.next(now());
      return deps.rng.chance(options.invalidRatio) ? corrupt(event, deps.rng) : event;
    });
    batchSizes.push(batch.length);

    const task = deps.post(batch).then((result) => {
      results.push(result);
      inFlight.delete(task);
      if (deps.onProgress && results.length % 20 === 0) {
        deps.onProgress(summarize(results, batchSizes, now().getTime() - startedAt));
      }
    });
    inFlight.add(task);
  }

  await Promise.all(inFlight);
  return summarize(results, batchSizes, now().getTime() - startedAt);
}
