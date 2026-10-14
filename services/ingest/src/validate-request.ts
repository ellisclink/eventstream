import {
  MAX_EVENT_BYTES,
  MAX_REQUEST_BYTES,
  ingestRequestSchema,
  parseEvent,
  type GameEvent,
  type RejectedEvent,
} from '@eventstream/schema';

export interface ValidEvent {
  readonly index: number;
  readonly event: GameEvent;
}

export type ValidationOutcome =
  | { readonly kind: 'malformed'; readonly message: string }
  | { readonly kind: 'too_large'; readonly message: string }
  | { readonly kind: 'checked'; readonly valid: ValidEvent[]; readonly rejected: RejectedEvent[] };

/**
 * Turns a raw request body into valid events and per-index rejections. A malformed body
 * (not JSON, wrong shape, too many events) rejects the whole request; otherwise each event
 * stands or falls on its own so one bad event doesn't drop a whole batch.
 */
export function validateRequest(body: string | null): ValidationOutcome {
  if (body === null || body.trim() === '') {
    return { kind: 'malformed', message: 'Request body is required.' };
  }

  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    return {
      kind: 'too_large',
      message: `Request body must be at most ${String(MAX_REQUEST_BYTES)} bytes.`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { kind: 'malformed', message: 'Request body must be valid JSON.' };
  }

  const request = ingestRequestSchema.safeParse(json);
  if (!request.success) {
    return {
      kind: 'malformed',
      message: 'Body must be {"events": [...]} with 1 to 100 events.',
    };
  }

  const valid: ValidEvent[] = [];
  const rejected: RejectedEvent[] = [];
  request.data.events.forEach((candidate, index) => {
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_EVENT_BYTES) {
      rejected.push({ index, issues: [`(root): event exceeds ${String(MAX_EVENT_BYTES)} bytes`] });
      return;
    }
    const result = parseEvent(candidate);
    if (result.ok) {
      valid.push({ index, event: result.event });
    } else {
      rejected.push({ index, issues: result.issues });
    }
  });

  return { kind: 'checked', valid, rejected };
}
