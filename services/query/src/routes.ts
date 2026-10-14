import type { APIGatewayProxyEvent } from 'aws-lambda';
import { z } from 'zod';

export const MAX_RANGE_DAYS = 31;

export type Route =
  | { readonly kind: 'player'; readonly playerId: string }
  | { readonly kind: 'day'; readonly date: string }
  | { readonly kind: 'range'; readonly dates: string[] }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'not_found' };

const playerIdSchema = z.string().trim().min(1).max(128);
const dateSchema = z.iso.date();

/**
 * Maps an API Gateway request to a typed route. API Gateway has already matched the path
 * template, so this checks parameters; anything unexpected becomes a 400 rather than an
 * exception.
 */
export function resolveRoute(
  event: Pick<APIGatewayProxyEvent, 'resource' | 'pathParameters' | 'queryStringParameters'>,
): Route {
  switch (event.resource) {
    case '/stats/players/{playerId}': {
      const parsed = playerIdSchema.safeParse(event.pathParameters?.['playerId']);
      return parsed.success
        ? { kind: 'player', playerId: parsed.data }
        : { kind: 'invalid', message: 'playerId must be 1 to 128 characters.' };
    }
    case '/stats/daily/{date}': {
      const parsed = dateSchema.safeParse(event.pathParameters?.['date']);
      return parsed.success
        ? { kind: 'day', date: parsed.data }
        : { kind: 'invalid', message: 'date must be YYYY-MM-DD.' };
    }
    case '/stats/daily': {
      const from = dateSchema.safeParse(event.queryStringParameters?.['from']);
      const to = dateSchema.safeParse(event.queryStringParameters?.['to']);
      if (!from.success || !to.success) {
        return { kind: 'invalid', message: 'from and to are required, as YYYY-MM-DD.' };
      }
      const dates = dateRange(from.data, to.data);
      if (dates.length === 0) {
        return { kind: 'invalid', message: 'from must not be after to.' };
      }
      if (dates.length > MAX_RANGE_DAYS) {
        return {
          kind: 'invalid',
          message: `A range can cover at most ${String(MAX_RANGE_DAYS)} days.`,
        };
      }
      return { kind: 'range', dates };
    }
    default:
      return { kind: 'not_found' };
  }
}

/** Inclusive list of UTC dates; stops early once it passes the cap so huge ranges stay cheap. */
export function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= end && dates.length <= MAX_RANGE_DAYS;
    t += 86_400_000
  ) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return dates;
}
