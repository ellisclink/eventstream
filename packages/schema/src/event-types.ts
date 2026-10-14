/**
 * The closed set of event types the pipeline accepts. Adding a type is a schema change
 * and must bump SCHEMA_VERSION.
 */
export const EVENT_TYPES = [
  'session_start',
  'session_end',
  'match_start',
  'match_end',
  'purchase',
  'level_up',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Current envelope version. Bump on any schema change so consumers can branch on it.
 * v1: placeholder payloads (Milestone 0). v2: typed payloads per event type (Milestone 1).
 */
export const SCHEMA_VERSION = 2;
