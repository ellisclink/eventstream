# Milestone 3: Processor

**Status:** done (2026-10-13). Code-complete and tested; you deploy it yourself.

## Scope

- An SQS-triggered processor Lambda with partial batch failure reporting.
- Exactly-once aggregates, idempotent by `event_id`.
- An on-demand DynamoDB table holding per-player and per-day aggregates.

## Done when

- [x] Unit tests for the aggregation rules, the DynamoDB request shapes, and batch failure
      handling.
- [x] A simulation against an in-memory table that applies the real update expressions:
      delivering every event twice, shuffled, gives the same aggregates as delivering once.
      Retries after failed transactions converge, and out-of-order `level_up` events keep the
      maximum.
- [x] CDK assertions: on-demand table with TTL, the event source mapping uses
      `ReportBatchItemFailures`, and IAM allows only Put, Update and ConditionCheck.

## Data model (single table, `pk` / `sk`)

| Item          | pk                 | sk       | Attributes                                                                                                             |
| ------------- | ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| Dedupe marker | `EVENT#<event_id>` | `SEEN`   | `event_type`, `received_at`, `expires_at` (TTL, 30 days)                                                               |
| Player totals | `PLAYER#<id>`      | `STATS`  | `events`, `sessions`, `matches_*`, `wins`, `kills`, `revenue_<CUR>_cents`, `level`, `first_seen_at`, `last_event_at` … |
| Daily totals  | `DAY#<yyyy-mm-dd>` | `TOTALS` | `events`, `count_<event_type>`, `play_seconds`, `revenue_<CUR>_cents`                                                  |

---

## Explanation

### What was built

| File                                           | Role                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/schema/src/stats.ts`                 | Key builders and stats types shared by the processor and the query API. |
| `services/processor/src/aggregate.ts`          | Pure function: one event → counter increments and its UTC date bucket.  |
| `services/processor/src/stats-store.ts`        | The transaction (dedupe + player + day), plus min/max bound updates.    |
| `services/processor/src/process-batch.ts`      | Parses records, groups them by player, collects per-message failures.   |
| `services/processor/src/handler.ts`            | Thin Lambda entry: clients, metrics, logging.                           |
| `infra/lib/constructs/stats-table.ts`          | The DynamoDB table.                                                     |
| `tests/services/processor/idempotency.test.ts` | The exactly-once simulation.                                            |

### How it works

1. SQS invokes the processor with up to 25 messages, or whatever arrives within 5 seconds.
   Each message is parsed against `queuedEventSchema`. A message that doesn't parse is marked
   failed. It can't succeed on a retry, so after 3 receives it lands in the DLQ for
   inspection.
2. Records are **grouped by player**, and groups run in parallel. Each group goes to
   `applyPlayerEvents` as a whole.
3. `applyPlayerEvents` sends one **`TransactWriteItems`** per player per batch. Groups larger
   than 48 events are split, to stay under the 100-item limit. Each transaction holds:
   - One `Put EVENT#<id>` per event with `attribute_not_exists(pk)`: the dedupe markers.
   - One `Update PLAYER#<id>` that `ADD`s the counters summed over all those events.
   - One `Update DAY#<date>` per UTC date involved, normally one.

   A transaction is all-or-nothing, so the counters change only if every marker was new. If
   some markers already exist, DynamoDB cancels the transaction, and `CancellationReasons`
   says which items failed. Those events are set aside as duplicates and the transaction is
   rebuilt from the rest. A crash halfway can't leave counters updated without their markers.
   Every group also updates the shared `DAY#<date>` item, so concurrent transactions can
   conflict there. `TransactionConflict` is retried up to 6 times with jittered exponential
   backoff (found in code review).

4. `level`, `first_seen_at` and `last_event_at` are a max or min, which `ADD` can't express.
   They're conditional updates outside the transaction (`attribute_not_exists(#a) OR #a <
:v`), written once per player per batch. A max or min is idempotent and order-independent,
   so repeating it is harmless.
5. The handler returns `{ batchItemFailures: [{ itemIdentifier }] }`. With
   `ReportBatchItemFailures` turned on, SQS deletes the successful messages and redelivers
   only the failed ones.

### Design choices

- **A transaction with a dedupe marker, not "check, then write".** Reading "have I seen this
  id?" and then writing is a race: two concurrent deliveries can both see "no". The
  conditional put inside the transaction is atomic. The tradeoff is cost: transactional writes
  cost twice the write capacity units. One transaction per event would cost about 8.3 write
  units per event; grouping per player per batch brings that to about 3.3–6.8, depending on
  how many events each player sends per batch (measured in the simulation). See
  docs/cost-and-load.md.
- **One transaction per player per batch, not per event.** It is 19–60% cheaper and cuts
  conflicts on the player item. The tradeoff is blast radius: a non-conflict error retries all
  of that player's events in the batch, not just one. Committed chunks are recognised as
  duplicates on redelivery, so the counters stay exact; only the processed and duplicate
  metrics drift slightly.
- **Powertools Idempotency utility considered.** It stores a result per idempotency key, but
  making the counters themselves exactly-once still needs the counter writes in the same
  transaction as the marker. The custom version is short and easier to explain.
- **Single table.** One table means one set of permissions, and point lookups by key. GSIs
  aren't needed for this milestone's access patterns.
- **UTC daily buckets.** One day boundary for every client. Local-time reports can be built in
  Athena later.
- **No unique-players count per day.** An exact distinct count needs a set or a marker per
  player per day, each with the same exactly-once problem. Athena's `COUNT(DISTINCT
player_id)` over the archive (Milestone 5) answers it accurately.
- **A bug found by the simulation.** The first version used `SET last_event_at` and
  `if_not_exists(first_seen_at)`. With out-of-order delivery those became "last processed"
  and "first processed" instead of the real latest and earliest.

### Interview questions

1. **SQS is at-least-once. How do you avoid double counting?** Every event has a unique
   `event_id`. The processor writes a dedupe marker with a condition that it doesn't exist yet,
   in the same DynamoDB transaction as the counter updates. A second delivery fails the
   condition, the whole transaction is cancelled, and nothing is counted twice.
2. **What are partial batch failures, and why use them?** Without them, one failing message
   makes Lambda report the whole batch as failed, so every message gets redelivered and
   reprocessed. With `ReportBatchItemFailures`, the function returns only the failed message
   ids, and only those are retried.
3. **Why process one player's events sequentially?** They all update the same item.
   DynamoDB cancels transactions that touch an item another transaction is updating at the
   same moment, so parallel writes to one player would cause conflicts and retries.
4. **How do you store a maximum like the player level when events arrive out of order?** Use a
   conditional update: set `level = :v` only if `level` doesn't exist or is lower. Max is
   idempotent and order-independent.
5. **What does the DLQ hold, and what would you do with it?** Messages that failed 3 times:
   malformed bodies or persistent errors. Inspect them, fix the cause, then redrive them to the
   main queue. Redriving is safe because processing is idempotent, and the 30-day dedupe TTL
   outlives the DLQ's 14-day retention.
