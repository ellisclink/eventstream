import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { errorResponse, json } from '../../shared/src/http.js';
import { playerSummary, toDailyStats, toPlayerStats } from './format.js';
import { resolveRoute } from './routes.js';
import type { StatsReader } from './stats-reader.js';

/** Aggregates change every few seconds; a short cache absorbs dashboards polling the API. */
const CACHE_HEADERS = { 'cache-control': 'max-age=10' };

export async function query(
  event: Pick<APIGatewayProxyEvent, 'resource' | 'pathParameters' | 'queryStringParameters'>,
  reader: StatsReader,
): Promise<APIGatewayProxyResult> {
  const route = resolveRoute(event);

  switch (route.kind) {
    case 'invalid':
      return errorResponse(400, route.message);
    case 'not_found':
      return errorResponse(404, 'Not found');
    case 'player': {
      const item = await reader.getPlayer(route.playerId);
      if (item === undefined) {
        return errorResponse(404, `No stats for player ${route.playerId}`);
      }
      return withCache(json(200, playerSummary(toPlayerStats(route.playerId, item))));
    }
    case 'day': {
      const item = await reader.getDay(route.date);
      if (item === undefined) {
        return errorResponse(404, `No stats for ${route.date}`);
      }
      return withCache(json(200, toDailyStats(route.date, item)));
    }
    case 'range': {
      const items = await reader.getDays(route.dates);
      // Every day in the range is returned, zero-filled, so charts don't need gap handling.
      const days = route.dates.map((date) => toDailyStats(date, items.get(date)));
      return withCache(json(200, { from: route.dates[0], to: route.dates.at(-1), days }));
    }
  }
}

function withCache(response: APIGatewayProxyResult): APIGatewayProxyResult {
  return { ...response, headers: { ...response.headers, ...CACHE_HEADERS } };
}
