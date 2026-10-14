import { z } from 'zod';

import { EVENT_TYPES, type EventType } from './event-types.js';
import { payloadSchemas } from './payloads.js';

/** Fields shared by every event, independent of event_type. */
const envelopeFields = {
  event_id: z.uuid(),
  schema_version: z.int().positive(),
  player_id: z.string().trim().min(1).max(128),
  // Client clocks are untrusted, but we still require a well-formed timestamp with a zone
  // so later date partitioning is unambiguous.
  occurred_at: z.iso.datetime({ offset: true }),
};

/**
 * Generic envelope: validates the shared fields and that payload is an object, without
 * checking the payload's shape. Useful where only routing information is needed.
 */
export const envelopeSchema = z.object({
  ...envelopeFields,
  event_type: z.enum(EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
});

function variant<T extends EventType>(type: T) {
  return z.object({
    ...envelopeFields,
    event_type: z.literal(type),
    payload: payloadSchemas[type],
  });
}

/**
 * Full event schema. A discriminated union on event_type means zod picks the right payload
 * schema from the type field instead of trying every variant, which also gives clearer errors.
 */
export const eventSchema = z.discriminatedUnion('event_type', [
  variant('session_start'),
  variant('session_end'),
  variant('match_start'),
  variant('match_end'),
  variant('purchase'),
  variant('level_up'),
]);

export type Envelope = z.infer<typeof envelopeSchema>;
export type GameEvent = z.infer<typeof eventSchema>;
/** Narrow a GameEvent to one event type, e.g. `EventOf<'purchase'>`. */
export type EventOf<T extends EventType> = Extract<GameEvent, { event_type: T }>;

export type ParseResult = { ok: true; event: GameEvent } | { ok: false; issues: string[] };

/**
 * Validate unknown input without throwing. Issues are "path: message" strings so callers can
 * count and report rejections without logging the raw (possibly sensitive) body.
 */
export function parseEvent(input: unknown): ParseResult {
  const result = eventSchema.safeParse(input);
  if (result.success) {
    return { ok: true, event: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}
