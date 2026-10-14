# Milestone 1: Ingest API

**Status:** done (2026-10-13). Code-complete and tested; you deploy it yourself.

## Scope

- REST API (API Gateway) with `POST /events`, an API key, and a usage plan that throttles each
  key.
- Ingest Lambda validates each event with zod, rejects bad ones, counts them, and sends valid
  ones to SQS in batches of 10.
- SQS queue with a dead-letter queue (DLQ).
- Real payload schemas for all six event types (`SCHEMA_VERSION` 1 → 2).

## Done when

- [x] `npm run check` passes, with handler unit tests and CDK assertions for the queue, DLQ,
      API key, usage plan, and IAM.
- [x] The bundled Lambda runs locally against a sample request (smoke test in EVIDENCE).

## API contract

`POST /events` with header `x-api-key: <key>`, and a body like `{"events": [ <event>, ... ]}`
holding 1 to 100 events.

| Status | Meaning                                                                                      |
| ------ | -------------------------------------------------------------------------------------------- |
| 202    | At least one event was queued. The body lists `rejected` (with issues) and `failed` indexes. |
| 400    | Malformed body, or no event was valid.                                                       |
| 403    | Missing or wrong API key. API Gateway returns this before Lambda runs.                       |
| 429    | The key exceeded its usage-plan throttle or quota.                                           |
| 503    | Valid events could not be queued. Safe to retry the `failed` indexes.                        |

Response body: `{"accepted": n, "rejected": [{"index": i, "issues": ["path: message"]}], "failed": [i]}`.

---

## Explanation

### What was built

| File                                                    | Role                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/schema/src/payloads.ts`                       | Strict zod schema for each event type's payload.                                        |
| `packages/schema/src/queue.ts`                          | Request shape, limits, and the `QueuedEvent` SQS message contract.                      |
| `services/ingest/src/validate-request.ts`               | Pure function: raw body → valid events and per-index rejections.                        |
| `services/ingest/src/queue-sender.ts`                   | Chunks into groups of 10, sends with `SendMessageBatch`, retries partial failures once. |
| `services/ingest/src/ingest.ts`                         | Combines validation and sending, and picks the status code.                             |
| `services/ingest/src/handler.ts`                        | Thin Lambda entry: decode body, call `ingest`, emit metrics, log ids.                   |
| `services/shared/src/*`                                 | JSON responses, env-var checks, Powertools setup.                                       |
| `infra/lib/constructs/api.ts`                           | REST API, stage, usage plan, API key, outputs.                                          |
| `infra/lib/constructs/event-queue.ts`                   | Queue + DLQ, encryption, TLS-only policy.                                               |
| `infra/lib/constructs/service-function.ts`              | Shared Lambda defaults (Node 22, ARM, X-Ray, 7-day logs, esbuild).                      |
| `tests/services/ingest/*`, `tests/infra/ingest.test.ts` | Unit tests with a mocked SQS client, plus infrastructure assertions.                    |

### How it works

1. API Gateway checks the `x-api-key` header against the keys in the usage plan. A missing
   key gets a 403 and an over-limit key gets a 429, before the Lambda is ever invoked, so
   abusive traffic costs nothing in Lambda.
2. The Lambda proxy integration passes the raw HTTP request to `handler`. `validateRequest`
   parses the JSON and checks the outer shape. It then validates **each event separately**,
   so a batch of 100 with one typo still delivers 99 events.
3. `sendToQueue` groups valid events into chunks of 10, the SQS batch limit. Each entry's
   `Id` is the event's index in the request, so a failure maps straight back to the event
   the client sent. SQS can fail single entries inside a successful call. Those are retried
   once and then reported as `failed`.
4. Each message body is `{ received_at, event }`. `received_at` is the server's clock and
   `occurred_at` is the client's. Keeping both lets later queries spot clients with skewed
   clocks.
5. Metrics (`EventsAccepted`, `EventsRejected`, `EventsQueueFailed`, `MalformedRequests`) go
   out as CloudWatch Embedded Metric Format: JSON log lines that CloudWatch turns into
   metrics, with no extra API calls.
6. If the processor keeps failing on a message, SQS moves it to the DLQ after 3 receives.
   The DLQ keeps messages for 14 days for inspection.

**Least privilege.** `queue.grantSendMessages(fn)` gives ingest `sqs:SendMessage`,
`GetQueueAttributes` and `GetQueueUrl`, and nothing else. A test checks the exact action list,
so a future change that widens it fails CI.

### Design choices

- **SQS between API and processing.** Without it, a slow DynamoDB or Firehose would
  slow down or fail client requests. With it, ingest stays fast and processing can retry on
  its own schedule. Alternatives: API Gateway straight to SQS (cheaper, but it can't validate
  with zod or return per-event errors), or Kinesis Data Streams (ordered and replayable, but
  priced per shard-hour, so it's never idle-free).
- **Per-event validation with a 202.** Clients get precise feedback without losing the whole
  batch. The tradeoff is a more complex response than a plain 200 or 400.
- **REST API rather than HTTP API.** HTTP APIs are cheaper but have no API keys or usage plans,
  which this project needs for per-producer throttling.
- **ARM64 Lambdas.** About 20% cheaper per GB-second than x86, and the code has no native
  dependencies.
- **Standard queue, not FIFO.** Ordering doesn't matter for aggregates, and duplicates are
  handled by idempotency in Milestone 3. FIFO would cap throughput and cost more.
- **Bundle size.** About 600 KB, mostly the X-Ray SDK pulled in by the Powertools tracer.
  The AWS SDK is excluded because the Node 22 runtime already ships it.

### Interview questions

1. **Why put a queue between the API and the processor?** It decouples them. Ingest latency no
   longer depends on downstream services, bursts are absorbed, failures retry automatically,
   and poison messages end up in a DLQ instead of blocking the pipeline.
2. **What happens if one event in a batch is invalid?** That event is listed in `rejected`
   with readable issues, the valid ones are queued, and the response is 202. Only a malformed
   body, or a batch where nothing is valid, gets a 400.
3. **How do you stop one producer from overwhelming the system?** Each producer gets its own
   API key in a usage plan with a rate limit, a burst limit, and a daily quota. API Gateway
   enforces them with 429s before Lambda runs. A stage-wide limit caps the total.
4. **Why is the visibility timeout 180 seconds?** AWS recommends at least six times the
   consumer's timeout (30 s). Otherwise a message can become visible again while a slow
   invocation is still processing it, and get processed twice.
5. **Why not log the request body?** It can contain player data, and logs are widely
   readable and kept for days. The handler logs event ids, types and counts, which is enough
   to trace a problem without exposing payloads.
