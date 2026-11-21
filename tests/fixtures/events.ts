import { randomUUID } from 'node:crypto';

import {
  SCHEMA_VERSION,
  type EventType,
  type GameEvent,
  type PayloadOf,
} from '@eventstream/schema';

export const samplePayloads: { [T in EventType]: PayloadOf<T> } = {
  session_start: {
    session_id: '6f1c1a8e-4b4f-4c47-9c0f-2b1f6c0f8a11',
    platform: 'pc',
    client_version: '1.4.2',
  },
  session_end: { session_id: '6f1c1a8e-4b4f-4c47-9c0f-2b1f6c0f8a11', duration_s: 1800 },
  match_start: { match_id: 'm-1', mode: 'ranked', map: 'dust' },
  match_end: { match_id: 'm-1', result: 'win', duration_s: 600, kills: 12, deaths: 3, score: 2400 },
  purchase: { item_id: 'skin-42', price_cents: 499, currency: 'USD' },
  level_up: { new_level: 7 },
};

/** A valid event as plain JSON, with optional overrides for building invalid cases. */
export function sampleEventJson(
  type: EventType = 'match_start',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: randomUUID(),
    event_type: type,
    schema_version: SCHEMA_VERSION,
    player_id: 'player-123',
    occurred_at: '2026-10-12T18:30:00.000Z',
    payload: samplePayloads[type],
    ...overrides,
  };
}

export function sampleEvent<T extends EventType>(
  type: T,
  overrides: Partial<Omit<GameEvent, 'event_type' | 'payload'>> & { payload?: PayloadOf<T> } = {},
): Extract<GameEvent, { event_type: T }> {
  return sampleEventJson(type, overrides) as Extract<GameEvent, { event_type: T }>;
}
