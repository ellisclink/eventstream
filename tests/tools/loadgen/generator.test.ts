import { eventSchema, type GameEvent } from '@eventstream/schema';

import { EventGenerator, corrupt } from '../../../tools/loadgen/src/generator';
import { Random } from '../../../tools/loadgen/src/random';

const NOW = new Date('2026-10-13T12:00:00.000Z');

function generate(count: number, seed = 42, players = 5): GameEvent[] {
  const generator = new EventGenerator(new Random(seed), players);
  return Array.from({ length: count }, () => generator.next(NOW));
}

describe('Random', () => {
  it('is reproducible for a given seed', () => {
    const a = new Random(7);
    const b = new Random(7);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
  });

  it('produces valid v4 UUIDs', () => {
    const rng = new Random(1);
    for (let i = 0; i < 50; i++) {
      expect(rng.uuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it('keeps int() within bounds', () => {
    const rng = new Random(3);
    const values = Array.from({ length: 500 }, () => rng.int(2, 4));
    expect(new Set(values)).toEqual(new Set([2, 3, 4]));
  });
});

describe('EventGenerator', () => {
  it('only produces events that pass the shared schema', () => {
    for (const event of generate(2000)) {
      const result = eventSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });

  it('is deterministic for a seed', () => {
    expect(generate(50, 9)).toEqual(generate(50, 9));
    expect(generate(50, 9)).not.toEqual(generate(50, 10));
  });

  it('produces every event type', () => {
    const types = new Set(generate(2000).map((e) => e.event_type));
    expect([...types].sort()).toEqual([
      'level_up',
      'match_end',
      'match_start',
      'purchase',
      'session_end',
      'session_start',
    ]);
  });

  it('keeps each player in a valid lifecycle', () => {
    const openMatch = new Map<string, string>();
    const inSession = new Set<string>();
    const level = new Map<string, number>();

    for (const e of generate(3000)) {
      const p = e.player_id;
      switch (e.event_type) {
        case 'session_start':
          expect(inSession.has(p)).toBe(false);
          inSession.add(p);
          break;
        case 'session_end':
          expect(inSession.has(p)).toBe(true);
          expect(openMatch.has(p)).toBe(false);
          inSession.delete(p);
          break;
        case 'match_start':
          expect(inSession.has(p)).toBe(true);
          openMatch.set(p, e.payload.match_id);
          break;
        case 'match_end':
          expect(openMatch.get(p)).toBe(e.payload.match_id);
          openMatch.delete(p);
          break;
        case 'level_up':
          expect(e.payload.new_level).toBe((level.get(p) ?? 1) + 1);
          level.set(p, e.payload.new_level);
          break;
        case 'purchase':
          expect(inSession.has(p)).toBe(true);
          break;
      }
    }
  });

  it('gives every event a unique id', () => {
    const ids = generate(2000).map((e) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('corrupt', () => {
  it('always produces an event the schema rejects, without mutating the original', () => {
    const rng = new Random(5);
    for (const event of generate(200)) {
      const before = JSON.stringify(event);
      expect(eventSchema.safeParse(corrupt(event, rng)).success).toBe(false);
      expect(JSON.stringify(event)).toBe(before);
    }
  });
});
