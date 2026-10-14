import { countAttribute, revenueAttribute, type GameEvent } from '@eventstream/schema';

/** Numeric attributes to ADD to an aggregate item. */
export type Counters = Record<string, number>;

export interface AggregateDeltas {
  readonly player: Counters;
  readonly day: Counters;
  /** UTC calendar date of occurred_at; the daily bucket the event belongs to. */
  readonly date: string;
}

/**
 * Pure mapping from one event to the counter increments it causes. Keeping this free of AWS
 * makes the business rules testable directly, and DynamoDB only ever sees ADD operations,
 * which are commutative, so events can arrive in any order.
 */
export function aggregateDeltas(event: GameEvent): AggregateDeltas {
  const player: Counters = { events: 1 };
  const day: Counters = { events: 1, [countAttribute(event.event_type)]: 1 };

  switch (event.event_type) {
    case 'session_start':
      player['sessions'] = 1;
      break;
    case 'session_end':
      player['session_seconds'] = event.payload.duration_s;
      break;
    case 'match_start':
      player['matches_started'] = 1;
      break;
    case 'match_end': {
      const { result, kills, deaths, score, duration_s } = event.payload;
      const outcome = { win: 'wins', loss: 'losses', draw: 'draws' } as const;
      Object.assign(player, {
        matches_played: 1,
        [outcome[result]]: 1,
        kills,
        deaths,
        score_total: score,
        play_seconds: duration_s,
      });
      day['play_seconds'] = duration_s;
      break;
    }
    case 'purchase': {
      const revenue = revenueAttribute(event.payload.currency);
      player['purchases'] = 1;
      player[revenue] = event.payload.price_cents;
      day[revenue] = event.payload.price_cents;
      break;
    }
    case 'level_up':
      player['level_ups'] = 1;
      break;
  }

  return { player, day, date: utcDate(event.occurred_at) };
}

/** "2026-10-12T23:30:00-02:00" belongs to 2026-10-13 in UTC; buckets use UTC everywhere. */
export function utcDate(isoTimestamp: string): string {
  return new Date(isoTimestamp).toISOString().slice(0, 10);
}

/**
 * Builds `ADD a :a, b :b` plus placeholder maps. Attribute names go through #placeholders
 * because names like "events" or revenue keys could collide with DynamoDB reserved words.
 */
export function addExpression(counters: Counters): {
  expression: string;
  names: Record<string, string>;
  values: Record<string, number>;
} {
  const names: Record<string, string> = {};
  const values: Record<string, number> = {};
  const parts = Object.entries(counters).map(([attr, value], i) => {
    names[`#c${String(i)}`] = attr;
    values[`:c${String(i)}`] = value;
    return `#c${String(i)} :c${String(i)}`;
  });
  return { expression: `ADD ${parts.join(', ')}`, names, values };
}

/** Sums two counter sets, so many events can become one ADD per item. */
export function mergeCounters(a: Counters, b: Counters): Counters {
  const merged: Counters = { ...a };
  for (const [attr, value] of Object.entries(b)) {
    merged[attr] = (merged[attr] ?? 0) + value;
  }
  return merged;
}
