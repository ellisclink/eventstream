import { SCHEMA_VERSION, type GameEvent } from '@eventstream/schema';

import type { Random } from './random.js';

type PlayerState =
  | { kind: 'offline' }
  | { kind: 'lobby'; sessionId: string }
  | { kind: 'in_match'; sessionId: string; matchId: string }
  | { kind: 'post_match'; sessionId: string };

interface Player {
  readonly id: string;
  level: number;
  state: PlayerState;
}

const PLATFORMS = ['pc', 'console', 'mobile'] as const;
const MODES = ['casual', 'ranked', 'custom'] as const;
const MAPS = ['dust', 'harbor', 'citadel', 'glacier'] as const;
const ITEMS = [
  { item_id: 'skin-ember', price_cents: 499 },
  { item_id: 'emote-wave', price_cents: 199 },
  { item_id: 'battle-pass', price_cents: 999 },
] as const;

/**
 * Simulates players as small state machines so the event stream is realistic: a session
 * starts before matches, every match_end has a match_start, levels only go up. Each call to
 * `next` advances one random player by one step and stamps the event with `now`.
 */
export class EventGenerator {
  private readonly players: Player[];

  constructor(
    private readonly rng: Random,
    playerCount: number,
  ) {
    this.players = Array.from({ length: playerCount }, (_, i) => ({
      id: `player-${String(i + 1).padStart(4, '0')}`,
      level: 1,
      state: { kind: 'offline' },
    }));
  }

  next(now: Date): GameEvent {
    const player = this.rng.pick(this.players);
    const base = {
      event_id: this.rng.uuid(),
      schema_version: SCHEMA_VERSION,
      player_id: player.id,
      occurred_at: now.toISOString(),
    };
    const { state } = player;

    switch (state.kind) {
      case 'offline': {
        const sessionId = this.rng.uuid();
        player.state = { kind: 'lobby', sessionId };
        return {
          ...base,
          event_type: 'session_start',
          payload: {
            session_id: sessionId,
            platform: this.rng.pick(PLATFORMS),
            client_version: '1.4.2',
          },
        };
      }
      case 'lobby': {
        if (this.rng.chance(0.2)) {
          player.state = { kind: 'offline' };
          return {
            ...base,
            event_type: 'session_end',
            payload: { session_id: state.sessionId, duration_s: this.rng.int(300, 7200) },
          };
        }
        const matchId = `m-${this.rng.uuid().slice(0, 8)}`;
        player.state = { kind: 'in_match', sessionId: state.sessionId, matchId };
        return {
          ...base,
          event_type: 'match_start',
          payload: { match_id: matchId, mode: this.rng.pick(MODES), map: this.rng.pick(MAPS) },
        };
      }
      case 'in_match': {
        player.state = { kind: 'post_match', sessionId: state.sessionId };
        const kills = this.rng.int(0, 25);
        return {
          ...base,
          event_type: 'match_end',
          payload: {
            match_id: state.matchId,
            result: this.rng.pick(['win', 'loss', 'loss', 'win', 'draw'] as const),
            duration_s: this.rng.int(120, 1500),
            kills,
            deaths: this.rng.int(0, 20),
            score: kills * 100 + this.rng.int(0, 500),
          },
        };
      }
      case 'post_match': {
        player.state = { kind: 'lobby', sessionId: state.sessionId };
        const roll = this.rng.next();
        if (roll < 0.3) {
          player.level += 1;
          return { ...base, event_type: 'level_up', payload: { new_level: player.level } };
        }
        if (roll < 0.45) {
          return {
            ...base,
            event_type: 'purchase',
            payload: { ...this.rng.pick(ITEMS), currency: 'USD' },
          };
        }
        // Nothing happened after this match; the player is back in the lobby, so emit the
        // next event from the stream instead.
        return this.next(now);
      }
    }
  }
}

/** Ways to break an event, for exercising the ingest API's rejection path. */
const CORRUPTIONS: ((event: Record<string, unknown>) => void)[] = [
  (e) => {
    delete e['event_id'];
  },
  (e) => {
    e['event_type'] = 'teleport';
  },
  (e) => {
    e['occurred_at'] = 'yesterday';
  },
  (e) => {
    e['payload'] = 'not-an-object';
  },
];

export function corrupt(event: GameEvent, rng: Random): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...event };
  rng.pick(CORRUPTIONS)(copy);
  return copy;
}
