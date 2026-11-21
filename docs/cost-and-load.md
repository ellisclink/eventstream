# Cost model and load testing

> **Estimates, not measurements.** These figures come from us-east-1 list prices at the time
> of writing, plus the pipeline's design (25 events per request from the load generator, up
> to 100 events per processor batch). The DynamoDB write units per event were measured in the
> repo's simulation (`tests/services/processor/idempotency.test.ts`), not in AWS. Check the
> prices against the AWS pricing pages. Then replace the estimates with numbers from
> **Cost Explorer**, filtered by the tag `project=eventstream`, after a load test.

## Idle cost (no traffic)

| Item                                                             | Monthly                                     |
| ---------------------------------------------------------------- | ------------------------------------------- |
| Lambda, API Gateway, SQS, DynamoDB on demand, Firehose, Athena   | $0 (billed per use)                         |
| CloudWatch: 8 alarms using exactly 10 alarm metrics, 1 dashboard | $0 (10 alarm metrics and 3 dashboards free) |
| S3 storage (archive, CDK bootstrap assets)                       | cents                                       |
| AWS Budgets (one budget, no actions)                             | $0                                          |
| **Total**                                                        | **≈ $0.05**                                 |

A test (`tests/infra/monitoring.test.ts`) fails if a change pushes the alarms past 10 metrics.

## Cost per 1 million events

| Service              | Driver                                                                                   | Estimate                        |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------- |
| DynamoDB on demand   | 3.3 to 6.8 write units per event (see below) × $0.625 per million                        | **~$2.10 – $4.25**              |
| Firehose             | 1M records, each billed as at least 5 KB → 5 GB × ~$0.029/GB, plus conversion ~$0.018/GB | ~$0.24                          |
| API Gateway REST     | 40,000 requests (25 events each) × $3.50/M                                               | ~$0.14                          |
| Lambda (ARM, 256 MB) | ingest 40k × ~100 ms, processor ~10k batches × ~2 s, plus requests                       | ~$0.10                          |
| SQS                  | ~150k API calls (batched send, receive, delete) × $0.40/M                                | ~$0.06                          |
| CloudWatch Logs      | ~100 MB of log and EMF lines × $0.50/GB                                                  | ~$0.05                          |
| S3 + Athena          | ~150 MB of Parquet; a few queries scanning MBs                                           | < $0.01                         |
| **Total**            |                                                                                          | **≈ $2.70 – $4.90 per million** |

It used to be about $6 per million, with roughly 8.3 write units per event.

### Why DynamoDB depends on traffic shape

The processor groups each batch by player and writes **one transaction per player per batch**.
That transaction holds a dedupe marker for each event, plus the player's and the day's counters
summed over those events. Transactional writes cost 2 write units per item, so N events from
one player cost about `2N + 4` units instead of `6N`, plus a couple of min/max writes per player.

| Distinct players in a 100-event batch | Write units per event (simulated) | vs. one transaction per event |
| ------------------------------------- | --------------------------------- | ----------------------------- |
| 20                                    | 3.3                               | −60%                          |
| 50                                    | 4.7                               | −44%                          |
| 200 (almost every event a new player) | 6.8                               | −19%                          |

Real game traffic is bursty per player: a session sends many events in a row. That puts it at
the cheaper end.

### Further savings, with tradeoffs

- Drop the `first_seen_at` and `last_event_at` writes and answer those questions from Athena
  instead. That saves about 2 units per player per batch, but the query API loses the fields.
- Switch DynamoDB to provisioned capacity once traffic is steady and predictable.
- HTTP API instead of REST would cut API cost by about 70%, but it has no API keys or usage
  plans. Producer throttling would then need a Lambda authorizer.

## Cost protection

The bigger risk at this scale is **runaway cost**, not the price per event. A leaked producer
key or a client stuck in a retry loop could send traffic all day.

| Guard                  | Default                                          | Worst case it allows                      |
| ---------------------- | ------------------------------------------------ | ----------------------------------------- |
| Ingest key daily quota | 10,000 requests/day                              | ≤ 1M events/day ≈ $3–5/day                |
| Ingest key rate        | 20 req/s (burst 40), also the stage-wide limit   | ≤ 2,000 events/s                          |
| Stats key              | 10 req/s (burst 20), 5,000 requests/day          | ~$0.02/day of reads                       |
| Request body size      | 1 MiB (413 above that)                           | No 10 MB bodies parsed                    |
| Processor concurrency  | 5                                                | Caps DynamoDB and Lambda spend per second |
| Athena                 | 1 GB scanned per query                           | ≤ $0.005 per query                        |
| AWS Budgets            | $5/month, emails at 80% actual and 100% forecast | You find out within hours                 |

For a bigger load test, raise the ingest limits for that deploy only:

```bash
npx cdk deploy EventstreamStack -c ingestRateLimit=100 -c ingestDailyQuota=100000
```

Redeploy without the flags afterwards to restore the defaults.

## Throughput limits by design

The processor manages about 5 concurrent invocations × 100 events ÷ ~2 s per batch, which is
roughly **250 events/s sustained**. Above that, the queue absorbs the excess, and the
`queue-backlog-age` alarm fires if the backlog grows older than 5 minutes. Raise
`maxConcurrency` in `eventstream-stack.ts` to process faster.

Aggregates lag ingest by up to about 10 seconds, because the processor waits up to 10 s to
fill a batch. That's a deliberate trade for fewer, cheaper writes.

## Load-test plan

Run each step for 5 minutes and let the queue drain between steps. The default quota allows
about 4,500 requests for the whole plan, which is within 10,000/day.

```bash
eval "$(npm run -s stack-info -- --export bash)"
for rate in 25 50 100 200; do
  npm run -s loadgen -- --rate $rate --duration 300 --batch-size 25 --players 200 --seed $rate > "load-$rate.json"
done
```

For each step, record the load generator summary and these dashboard numbers:

| Offered events/s | Accepted | Rejected | Failed | API p50 / p99 (ms) | Ingest → processed p99 (ms) | Max backlog age (s) | DLQ |
| ---------------- | -------- | -------- | ------ | ------------------ | --------------------------- | ------------------- | --- |
| 25               |          |          |        |                    |                             |                     |     |
| 50               |          |          |        |                    |                             |                     |     |
| 100              |          |          |        |                    |                             |                     |     |
| 200              |          |          |        |                    |                             |                     |     |

What to expect, to check against the results:

- API latency stays flat at every rate, because ingest only enqueues.
- Ingest-to-processed delay sits around 10 s, the batching window.
- The DLQ stays at 0. If it doesn't, check the processor logs for `TransactionConflict` that
  survived 6 retries.

After the test, add the day's cost from Cost Explorer (it lags about 24 h) to get the real
cost per million events. Compare it with the simulated write units in the table above.
