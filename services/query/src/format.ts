import {
  EVENT_TYPES,
  countAttribute,
  type DailyStats,
  type EventType,
  type PlayerStats,
} from '@eventstream/schema';

type Item = Record<string, unknown>;

const num = (item: Item, attr: string): number => {
  const value = item[attr];
  return typeof value === 'number' ? value : 0;
};

const str = (item: Item, attr: string): string | null => {
  const value = item[attr];
  return typeof value === 'string' ? value : null;
};

/** Collects revenue_<CUR>_cents attributes into { CUR: cents }. */
export function revenueByCurrency(item: Item): Record<string, number> {
  const revenue: Record<string, number> = {};
  for (const [attr, value] of Object.entries(item)) {
    const match = /^revenue_([A-Z]{3})_cents$/.exec(attr);
    if (match?.[1] !== undefined && typeof value === 'number') {
      revenue[match[1]] = value;
    }
  }
  return revenue;
}

/**
 * Turns a raw DynamoDB item into the public response shape. Counters that were never
 * incremented don't exist on the item, so every field defaults to zero; the API contract
 * stays stable no matter which events a player has sent.
 */
export function toPlayerStats(playerId: string, item: Item): PlayerStats {
  return {
    player_id: playerId,
    events: num(item, 'events'),
    sessions: num(item, 'sessions'),
    session_seconds: num(item, 'session_seconds'),
    matches_started: num(item, 'matches_started'),
    matches_played: num(item, 'matches_played'),
    wins: num(item, 'wins'),
    losses: num(item, 'losses'),
    draws: num(item, 'draws'),
    kills: num(item, 'kills'),
    deaths: num(item, 'deaths'),
    score_total: num(item, 'score_total'),
    play_seconds: num(item, 'play_seconds'),
    purchases: num(item, 'purchases'),
    revenue_cents: revenueByCurrency(item),
    level: num(item, 'level') || 1,
    level_ups: num(item, 'level_ups'),
    first_seen_at: str(item, 'first_seen_at'),
    last_event_at: str(item, 'last_event_at'),
  };
}

export function toDailyStats(date: string, item: Item | undefined): DailyStats {
  const source = item ?? {};
  const counts = Object.fromEntries(
    EVENT_TYPES.map((type) => [type, num(source, countAttribute(type))]),
  ) as Record<EventType, number>;
  return {
    date,
    events: num(source, 'events'),
    counts,
    play_seconds: num(source, 'play_seconds'),
    revenue_cents: revenueByCurrency(source),
  };
}

/** Derived, so clients don't each reimplement (and divide-by-zero) the same formulas. */
export function playerSummary(stats: PlayerStats) {
  const decided = stats.wins + stats.losses + stats.draws;
  return {
    ...stats,
    win_rate: decided > 0 ? Math.round((stats.wins / decided) * 1000) / 1000 : null,
    kd_ratio: stats.deaths > 0 ? Math.round((stats.kills / stats.deaths) * 100) / 100 : null,
  };
}
