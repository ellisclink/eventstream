import { addExpression, aggregateDeltas, utcDate } from '../../../services/processor/src/aggregate';
import { sampleEvent, samplePayloads } from '../../fixtures/events';

describe('aggregateDeltas', () => {
  it('counts every event for the player and the day', () => {
    const deltas = aggregateDeltas(sampleEvent('session_start'));
    expect(deltas.player).toEqual({ events: 1, sessions: 1 });
    expect(deltas.day).toEqual({ events: 1, count_session_start: 1 });
    expect(deltas.date).toBe('2026-10-12');
  });

  it('turns a match_end into result, kills, deaths, score and play time', () => {
    const deltas = aggregateDeltas(sampleEvent('match_end'));
    expect(deltas.player).toEqual({
      events: 1,
      matches_played: 1,
      wins: 1,
      kills: 12,
      deaths: 3,
      score_total: 2400,
      play_seconds: 600,
    });
    expect(deltas.day).toMatchObject({ count_match_end: 1, play_seconds: 600 });
  });

  it.each([
    ['loss', 'losses'],
    ['draw', 'draws'],
  ] as const)('counts a %s', (result, attribute) => {
    const event = sampleEvent('match_end', { payload: { ...samplePayloads.match_end, result } });
    expect(aggregateDeltas(event).player[attribute]).toBe(1);
  });

  it('keeps revenue per currency in integer cents', () => {
    const event = sampleEvent('purchase', {
      payload: { item_id: 'x', price_cents: 250, currency: 'EUR' },
    });
    const deltas = aggregateDeltas(event);
    expect(deltas.player).toEqual({ events: 1, purchases: 1, revenue_EUR_cents: 250 });
    expect(deltas.day['revenue_EUR_cents']).toBe(250);
  });

  it('adds session duration and level-up counts', () => {
    expect(aggregateDeltas(sampleEvent('session_end')).player['session_seconds']).toBe(1800);
    expect(aggregateDeltas(sampleEvent('level_up')).player['level_ups']).toBe(1);
    expect(aggregateDeltas(sampleEvent('match_start')).player['matches_started']).toBe(1);
  });
});

describe('utcDate', () => {
  it('buckets by UTC date, not the client offset', () => {
    expect(utcDate('2026-10-12T23:30:00-02:00')).toBe('2026-10-13');
    expect(utcDate('2026-10-13T00:30:00+02:00')).toBe('2026-10-12');
  });
});

describe('addExpression', () => {
  it('uses placeholders for every attribute name and value', () => {
    expect(addExpression({ events: 1, revenue_USD_cents: 499 })).toEqual({
      expression: 'ADD #c0 :c0, #c1 :c1',
      names: { '#c0': 'events', '#c1': 'revenue_USD_cents' },
      values: { ':c0': 1, ':c1': 499 },
    });
  });
});
