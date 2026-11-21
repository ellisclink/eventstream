import type { APIGatewayProxyEvent } from 'aws-lambda';

import {
  playerSummary,
  revenueByCurrency,
  toDailyStats,
  toPlayerStats,
} from '../../../services/query/src/format';
import { query } from '../../../services/query/src/query';
import { dateRange, resolveRoute } from '../../../services/query/src/routes';
import type { StatsReader } from '../../../services/query/src/stats-reader';

type RouteEvent = Pick<
  APIGatewayProxyEvent,
  'resource' | 'pathParameters' | 'queryStringParameters'
>;

const req = (
  resource: string,
  pathParameters: Record<string, string> | null = null,
  queryStringParameters: Record<string, string> | null = null,
): RouteEvent => ({ resource, pathParameters, queryStringParameters });

function reader(items: Record<string, Record<string, unknown>> = {}): StatsReader {
  return {
    getPlayer: (id) => Promise.resolve(items[`PLAYER#${id}`]),
    getDay: (date) => Promise.resolve(items[`DAY#${date}`]),
    getDays: (dates) =>
      Promise.resolve(
        new Map(
          dates.flatMap((d) => {
            const item = items[`DAY#${d}`];
            return item ? [[d, item] as const] : [];
          }),
        ),
      ),
  };
}

const body = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;

describe('resolveRoute', () => {
  it.each([
    [req('/stats/players/{playerId}', { playerId: 'p1' }), { kind: 'player', playerId: 'p1' }],
    [req('/stats/daily/{date}', { date: '2026-10-13' }), { kind: 'day', date: '2026-10-13' }],
    [req('/nope'), { kind: 'not_found' }],
  ])('resolves %j', (event, expected) => {
    expect(resolveRoute(event)).toEqual(expected);
  });

  it.each([
    req('/stats/players/{playerId}', { playerId: '  ' }),
    req('/stats/daily/{date}', { date: '2026-13-01' }),
    req('/stats/daily/{date}', { date: '13-10-2026' }),
    req('/stats/daily', null, { from: '2026-10-01' }),
    req('/stats/daily', null, { from: '2026-10-10', to: '2026-10-01' }),
    req('/stats/daily', null, { from: '2026-01-01', to: '2026-12-31' }),
  ])('rejects bad parameters %#', (event) => {
    expect(resolveRoute(event).kind).toBe('invalid');
  });
});

describe('dateRange', () => {
  it('is inclusive and crosses month ends', () => {
    expect(dateRange('2026-09-29', '2026-10-02')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('stops just past the cap instead of building a huge list', () => {
    expect(dateRange('2000-01-01', '2099-12-31')).toHaveLength(32);
  });
});

describe('format', () => {
  it('defaults missing counters to zero and level to 1', () => {
    const stats = toPlayerStats('p1', { events: 3 });
    expect(stats).toMatchObject({
      player_id: 'p1',
      events: 3,
      wins: 0,
      level: 1,
      first_seen_at: null,
    });
  });

  it('collects revenue by currency', () => {
    expect(
      revenueByCurrency({ revenue_USD_cents: 499, revenue_EUR_cents: 100, events: 2 }),
    ).toEqual({
      USD: 499,
      EUR: 100,
    });
  });

  it('derives win rate and K/D, avoiding divide-by-zero', () => {
    const full = playerSummary(toPlayerStats('p', { wins: 3, losses: 1, kills: 10, deaths: 4 }));
    expect(full).toMatchObject({ win_rate: 0.75, kd_ratio: 2.5 });
    const empty = playerSummary(toPlayerStats('p', {}));
    expect(empty).toMatchObject({ win_rate: null, kd_ratio: null });
  });

  it('zero-fills a day with every event type', () => {
    const day = toDailyStats('2026-10-13', undefined);
    expect(day.events).toBe(0);
    expect(Object.keys(day.counts)).toHaveLength(6);
  });
});

describe('query', () => {
  it('returns player stats with a short cache header', async () => {
    const result = await query(
      req('/stats/players/{playerId}', { playerId: 'p1' }),
      reader({ 'PLAYER#p1': { events: 5, wins: 1, revenue_USD_cents: 999 } }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.headers?.['cache-control']).toBe('max-age=10');
    expect(body(result)).toMatchObject({ player_id: 'p1', events: 5, revenue_cents: { USD: 999 } });
  });

  it('returns 404 for an unknown player or day', async () => {
    expect(
      (await query(req('/stats/players/{playerId}', { playerId: 'ghost' }), reader())).statusCode,
    ).toBe(404);
    expect(
      (await query(req('/stats/daily/{date}', { date: '2026-10-13' }), reader())).statusCode,
    ).toBe(404);
  });

  it('returns 400 for bad input without touching the table', async () => {
    const r = reader();
    const spy = jest.spyOn(r, 'getDay');
    const result = await query(req('/stats/daily/{date}', { date: 'yesterday' }), r);
    expect(result.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns every day in a range, zero-filling gaps', async () => {
    const result = await query(
      req('/stats/daily', null, { from: '2026-10-12', to: '2026-10-14' }),
      reader({ 'DAY#2026-10-13': { date: '2026-10-13', events: 7, count_purchase: 2 } }),
    );
    const days = body(result)['days'] as { date: string; events: number }[];
    expect(days.map((d) => [d.date, d.events])).toEqual([
      ['2026-10-12', 0],
      ['2026-10-13', 7],
      ['2026-10-14', 0],
    ]);
  });
});
