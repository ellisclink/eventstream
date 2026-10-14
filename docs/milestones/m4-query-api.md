# Milestone 4: Query API

**Status:** done (2026-10-13). Code-complete and tested; you deploy it yourself.

## Endpoints

All of them need the `x-api-key` header and return JSON with `cache-control: max-age=10`.

| Method and path                                  | Returns                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `GET /stats/players/{playerId}`                  | Player totals, plus derived `win_rate` and `kd_ratio`. 404 if unknown. |
| `GET /stats/daily/{date}`                        | One UTC day: event counts per type, play time, revenue per currency.   |
| `GET /stats/daily?from=YYYY-MM-DD&to=YYYY-MM-DD` | Up to 31 days, inclusive, with days that had no events zero-filled.    |

Bad parameters return 400 with a message, and nothing is read from the table.

```bash
curl -H "x-api-key: $EVENTSTREAM_STATS_KEY" "${EVENTSTREAM_STATS_URL}stats/players/player-0001"
curl -H "x-api-key: $EVENTSTREAM_STATS_KEY" "${EVENTSTREAM_STATS_URL}stats/daily?from=2026-10-01&to=2026-10-13"
```

## Done when

- [x] Unit tests for routing and validation, response formatting, the BatchGet retry, and the
      handler's error path (a 500 that doesn't leak internals).
- [x] CDK assertions: 3 GET methods, all requiring an API key, and IAM limited to
      `GetItem` and `BatchGetItem`.

---

## Explanation

### What was built

| File                                 | Role                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `services/query/src/routes.ts`       | Request → typed `Route`, validating path and query parameters with zod.  |
| `services/query/src/format.ts`       | DynamoDB item → public response shape, with defaults and derived ratios. |
| `services/query/src/stats-reader.ts` | `GetItem` and `BatchGetItem`, retrying unprocessed keys.                 |
| `services/query/src/query.ts`        | Picks the status code and builds the response for each route.            |
| `services/query/src/handler.ts`      | Thin Lambda entry: clients, metrics, logging.                            |

### How it works

- API Gateway matches the path template and passes it in `event.resource`, for example
  `/stats/daily/{date}`. `resolveRoute` switches on that value, so the Lambda never parses
  URL paths itself.
- Every lookup is a **point read by primary key**: `PLAYER#<id>/STATS` or `DAY#<date>/TOTALS`.
  The single-table key design from M3 was chosen so that no query needs a Scan or a GSI.
- A date range uses one `BatchGetItem` with up to 31 keys (the limit is 100). DynamoDB may
  return some keys as `UnprocessedKeys` when throttled. The reader asks again for just those,
  and fails after 3 retries rather than returning a silently incomplete range.
- `format.ts` gives every counter a default of zero. Attributes only exist on an item once
  they've been incremented, so without defaults the response shape would change depending on
  which events a player happened to send.

### Design choices

- **Same Lambda for every stats route.** One function means one cold-start pool and one set of
  permissions. The routes are tiny, so separate functions would only add deploy surface.
- **Read-only IAM, with no Scan or Query.** Even a bug or an injected parameter can only fetch
  single items by key. It can't page through the whole table.
- **A 10-second cache header.** Aggregates update within seconds anyway. A dashboard polling
  every second would otherwise cost 10 times as many reads. Adding API Gateway stage caching
  would make this stronger, but it bills per hour, so it's left out.
- **Zero-filled ranges.** Chart code downstream doesn't have to handle gaps.

### Interview questions

1. **Why does every query use a point read?** Point reads by primary key cost a predictable
   0.5 RCU (eventually consistent) and are fast at any table size. Scans read and bill for the
   whole table. The key design was chosen to match these access patterns.
2. **What is `UnprocessedKeys`, and how do you handle it?** BatchGetItem may return only part
   of the result when it hits throughput limits. You retry just the unprocessed keys, ideally
   with backoff, and fail clearly if they never come back.
3. **How do you stop the query API from leaking internal errors?** The handler catches
   everything, logs the error with the request id, and returns a generic 500. A test asserts
   that the error text doesn't appear in the response body.
4. **How would you add a leaderboard?** Add a GSI keyed on a fixed partition with the score as
   the sort key, or write sharded top-N items from the processor. Each choice trades write cost
   against read flexibility. Alternatively, compute the leaderboard in Athena on a schedule.
