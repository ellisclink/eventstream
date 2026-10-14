import type { IngestResponse } from '@eventstream/schema';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PostResult {
  readonly status: number;
  readonly accepted: number;
  readonly rejected: number;
  /** Events still not queued after all retries. */
  readonly failed: number;
  readonly attempts: number;
  readonly latencyMs: number;
}

export interface ClientOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Posts one batch to POST /events. Throttling (429) and server errors back off and retry;
 * on a 202 with `failed` indexes, only those events are resent, which is safe because the
 * processor deduplicates by event_id.
 */
export async function postBatch(
  events: readonly unknown[],
  options: ClientOptions,
): Promise<PostResult> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = options.maxAttempts ?? 4;

  let pending = [...events];
  let accepted = 0;
  let rejected = 0;
  let status = 0;
  let attempts = 0;
  const started = performance.now();

  while (pending.length > 0 && attempts < maxAttempts) {
    if (attempts > 0) {
      // Exponential backoff with jitter: 200 ms, 400 ms, 800 ms ... plus up to 100 ms.
      await sleep(200 * 2 ** (attempts - 1) + Math.random() * 100);
    }
    attempts++;

    let response: Response;
    try {
      response = await doFetch(options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey },
        body: JSON.stringify({ events: pending }),
      });
    } catch {
      status = 0;
      continue;
    }
    status = response.status;

    if (RETRYABLE.has(status)) {
      continue;
    }
    if (status !== 202 && status !== 400) {
      // 403 (bad key) and other client errors won't improve with retries.
      break;
    }

    const body = (await response.json()) as Partial<IngestResponse>;
    accepted += body.accepted ?? 0;
    rejected += body.rejected?.length ?? 0;
    const failedIndexes = body.failed ?? [];
    pending = failedIndexes.map((i) => pending[i]).filter((e) => e !== undefined);
  }

  return {
    status,
    accepted,
    rejected,
    failed: pending.length,
    attempts,
    latencyMs: performance.now() - started,
  };
}
