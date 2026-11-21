import type { GameEvent, IngestResponse } from '@eventstream/schema';

import type { SendResult } from './queue-sender.js';
import { validateRequest, type ValidEvent } from './validate-request.js';

export interface IngestDeps {
  readonly send: (events: readonly ValidEvent[], receivedAt: Date) => Promise<SendResult>;
  readonly now: () => Date;
}

export interface IngestOutcome {
  readonly statusCode: number;
  readonly body: IngestResponse | { message: string };
  /** Accepted events, for logging ids and types (never full bodies). */
  readonly accepted: Pick<GameEvent, 'event_id' | 'event_type'>[];
  readonly rejectedCount: number;
  readonly failedCount: number;
  readonly malformed: boolean;
}

/**
 * Status codes: 202 when at least one event was queued (the body says which were not),
 * 400 when nothing was valid, 503 when valid events could not be queued at all so the
 * client knows a retry may succeed.
 */
export async function ingest(body: string | null, deps: IngestDeps): Promise<IngestOutcome> {
  const outcome = validateRequest(body);
  if (outcome.kind === 'malformed' || outcome.kind === 'too_large') {
    return {
      statusCode: outcome.kind === 'too_large' ? 413 : 400,
      body: { message: outcome.message },
      accepted: [],
      rejectedCount: 0,
      failedCount: 0,
      malformed: true,
    };
  }

  const { valid, rejected } = outcome;
  const result: SendResult =
    valid.length > 0 ? await deps.send(valid, deps.now()) : { sent: [], failed: [] };

  const sentIndexes = new Set(result.sent);
  const accepted = valid
    .filter((v) => sentIndexes.has(v.index))
    .map(({ event }) => ({ event_id: event.event_id, event_type: event.event_type }));

  let statusCode = 202;
  if (accepted.length === 0) {
    statusCode = result.failed.length > 0 ? 503 : 400;
  }

  return {
    statusCode,
    body: { accepted: accepted.length, rejected, failed: result.failed },
    accepted,
    rejectedCount: rejected.length,
    failedCount: result.failed.length,
    malformed: false,
  };
}
