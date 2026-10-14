import { z } from 'zod';

import type { EventType } from './event-types.js';

// Payloads are strict: unknown keys are rejected so typos surface at ingest instead of
// silently disappearing from aggregates.

const id = z.string().trim().min(1).max(64);
const nonNegativeInt = z.int().min(0);

export const sessionStartPayload = z.strictObject({
  session_id: z.uuid(),
  platform: z.enum(['pc', 'console', 'mobile']),
  client_version: z.string().trim().min(1).max(32),
});

export const sessionEndPayload = z.strictObject({
  session_id: z.uuid(),
  // A day-long cap catches clients that never sent session_end and report a bogus duration.
  duration_s: nonNegativeInt.max(86_400),
});

export const matchStartPayload = z.strictObject({
  match_id: id,
  mode: z.enum(['casual', 'ranked', 'custom']),
  map: id,
});

export const matchEndPayload = z.strictObject({
  match_id: id,
  result: z.enum(['win', 'loss', 'draw']),
  duration_s: nonNegativeInt.max(86_400),
  kills: nonNegativeInt.max(10_000),
  deaths: nonNegativeInt.max(10_000),
  score: nonNegativeInt.max(10_000_000),
});

export const purchasePayload = z.strictObject({
  item_id: id,
  // Integer minor units (cents) avoid floating-point rounding in revenue sums.
  price_cents: nonNegativeInt.max(100_000),
  currency: z.string().regex(/^[A-Z]{3}$/, 'expected an ISO-4217 code like USD'),
});

export const levelUpPayload = z.strictObject({
  new_level: z.int().min(1).max(1_000),
});

export const payloadSchemas = {
  session_start: sessionStartPayload,
  session_end: sessionEndPayload,
  match_start: matchStartPayload,
  match_end: matchEndPayload,
  purchase: purchasePayload,
  level_up: levelUpPayload,
} satisfies Record<EventType, z.ZodType>;

export type PayloadOf<T extends EventType> = z.infer<(typeof payloadSchemas)[T]>;
