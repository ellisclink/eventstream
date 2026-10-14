import type { EventType } from './event-types.js';

/**
 * DynamoDB single-table keys, shared by the processor (writes) and the query API (reads).
 * Prefixes keep different item kinds from colliding in one table.
 */
export const keys = {
  event: (eventId: string) => ({ pk: `EVENT#${eventId}`, sk: 'SEEN' }),
  player: (playerId: string) => ({ pk: `PLAYER#${playerId}`, sk: 'STATS' }),
  day: (date: string) => ({ pk: `DAY#${date}`, sk: 'TOTALS' }),
} as const;

/** Revenue is stored per currency, e.g. revenue_USD_cents; summing across currencies is wrong. */
export const revenueAttribute = (currency: string) => `revenue_${currency}_cents`;
export const countAttribute = (type: EventType) => `count_${type}`;

export interface PlayerStats {
  readonly player_id: string;
  readonly events: number;
  readonly sessions: number;
  readonly session_seconds: number;
  readonly matches_started: number;
  readonly matches_played: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly kills: number;
  readonly deaths: number;
  readonly score_total: number;
  readonly play_seconds: number;
  readonly purchases: number;
  readonly revenue_cents: Record<string, number>;
  readonly level: number;
  readonly level_ups: number;
  readonly first_seen_at: string | null;
  readonly last_event_at: string | null;
}

export interface DailyStats {
  readonly date: string;
  readonly events: number;
  readonly counts: Record<EventType, number>;
  readonly play_seconds: number;
  readonly revenue_cents: Record<string, number>;
}
