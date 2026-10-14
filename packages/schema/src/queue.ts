import { z } from 'zod';

import { eventSchema } from './envelope.js';

/** API Gateway allows 10 MB, but a bounded batch keeps Lambda latency and memory predictable. */
export const MAX_EVENTS_PER_REQUEST = 100;
/** Well under the 256 KB SQS message limit, so one event always fits in one message. */
export const MAX_EVENT_BYTES = 8 * 1024;
/**
 * API Gateway accepts bodies up to 10 MB. A valid request is at most ~800 KB (100 x 8 KB), so
 * anything larger is rejected before JSON.parse spends memory and CPU on it.
 */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * The SQS message body the ingest Lambda writes and the processor reads. Wrapping the event
 * lets the server record when it accepted it, which is trustworthy unlike occurred_at.
 */
export const queuedEventSchema = z.object({
  received_at: z.iso.datetime(),
  event: eventSchema,
});

export type QueuedEvent = z.infer<typeof queuedEventSchema>;

/** Shape of POST /events. Items are validated one by one so one bad event can't sink the batch. */
export const ingestRequestSchema = z.object({
  events: z.array(z.unknown()).min(1).max(MAX_EVENTS_PER_REQUEST),
});

export interface RejectedEvent {
  readonly index: number;
  readonly issues: string[];
}

export interface IngestResponse {
  readonly accepted: number;
  readonly rejected: RejectedEvent[];
  /** Valid events that could not be queued; the client may retry exactly these indexes. */
  readonly failed: number[];
}
