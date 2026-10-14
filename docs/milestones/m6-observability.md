# Milestone 6: Observability and alerts

**Status:** done (2026-10-13). Code-complete and tested; you deploy it yourself.

## Scope

- Powertools for AWS Lambda in every handler: structured JSON logs, metrics in Embedded Metric
  Format (EMF), and X-Ray tracing of AWS SDK calls. These were added from Milestone 1 onward,
  so every handler was written with them from the start.
- X-Ray tracing on all three Lambdas and on the API Gateway stage.
- A CloudWatch dashboard named `eventstream`.
- 8 alarms that notify an SNS topic, with an optional email subscription.

## Enabling email alerts

```bash
npx cdk deploy EventstreamStack -c alertEmail=you@example.com
# or reuse the budget address: -c budgetEmail=you@example.com
```

AWS sends a **confirmation email**, and alerts arrive only after you click the link in it.

## Alarms

| Alarm                 | Fires when                                                           | First thing to check                              |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| `dlq-not-empty`       | Any message is in the DLQ                                            | Processor logs for that `event_id`, then redrive  |
| `queue-backlog-age`   | The oldest message is over 5 minutes old, for 10 minutes             | Processor errors and throttles, DynamoDB          |
| `lambda-errors`       | Any Lambda error or timeout                                          | The function's logs, X-Ray traces                 |
| `lambda-throttles`    | Any Lambda throttle                                                  | Account concurrency limit                         |
| `api-5xx`             | More than 5 API server errors in 5 minutes                           | Ingest or query logs                              |
| `ingest-reject-rate`  | Over 20% of events rejected (when at least 50 events were sent)      | `EventsRejected`; which client changed its schema |
| `processing-failures` | More than 10 apply or archive failures per 5 minutes, for 10 minutes | Processor logs                                    |
| `archive-freshness`   | Firehose holds data older than 15 minutes                            | Firehose error output under `s3://…/errors/`      |

## Done when

- [x] CDK assertions: exactly these 8 alarms, each with ALARM and OK actions on the topic
      and `notBreaching` for missing data; the dashboard exists; the topic enforces TLS; the
      email subscription exists only when an address is configured; tracing is on for all
      functions.
- [x] A test that the alarm namespace equals the namespace the Lambdas emit metrics to.

---

## Explanation

### What was built

| File                                   | Role                                                            |
| -------------------------------------- | --------------------------------------------------------------- |
| `services/shared/src/observability.ts` | One Powertools Logger, Metrics and Tracer per Lambda.           |
| `infra/lib/constructs/monitoring.ts`   | SNS topic, the 8 alarms, and the dashboard.                     |
| `infra/lib/config.ts`                  | Reads `alertEmail` from context, falling back to `budgetEmail`. |

### How it works

- **Metrics without API calls.** `metrics.addMetric('EventsRejected', Count, n)` buffers the
  value. `publishStoredMetrics()` writes one JSON log line in EMF format, and CloudWatch Logs
  extracts it into the `Eventstream` namespace with a `service` dimension. Calling
  `PutMetricData` instead would add latency and per-request cost to every invocation.
- **Traces.** `tracer.captureAWSv3Client(client)` wraps each SDK client, so X-Ray shows API
  Gateway → Lambda → SQS, DynamoDB or Firehose, with a timing for each call. That makes it easy
  to see whether a slow request was waiting on DynamoDB or on cold start.
- **Composite metrics.** `lambda-errors` sums three functions' error metrics in one CloudWatch
  metric-math expression, so a single alarm covers all of them. `ingest-reject-rate` computes a
  percentage, with `IF(total >= 50, …)` so a single bad test request doesn't page anyone.
- **Missing data is not breaching.** A pipeline with no traffic emits no data points. Without
  this setting, an idle dev stack would sit in `INSUFFICIENT_DATA` or raise false alarms.
- **OK actions.** Each alarm also emails when it recovers, so you know an incident is over
  without checking the console.

### Design choices

- **8 alarms, exactly 10 alarm metrics.** CloudWatch bills an alarm per metric it
  evaluates ($0.10 per metric per month, first 10 free), so a metric-math alarm over three
  functions counts as three. Lambda errors and throttles therefore use the account-wide
  `AWS/Lambda` metrics (one metric each, no function dimension), and the processor emits one
  combined `ProcessingFailures` metric. A test pins the total at 10, so alerting is free. Each account gets 3 dashboards
  free; beyond that a dashboard costs $3/month.
- **`FILL(m, 0)` in summed alarms.** Lambda publishes `Errors` only for periods with
  invocations, and metric math produces no datapoint unless every operand has one. Without
  `FILL`, an idle query function would silently mask ingest errors.
- **Alert on symptoms, not causes.** Backlog age, DLQ depth, error rates and archive freshness
  are what users of the data notice. CPU or memory alarms would be noisy and wouldn't tell you
  what to do.
- **No encryption on the SNS topic.** CloudWatch alarms can't publish to a topic encrypted
  with the AWS-managed SNS key, and alert messages contain only alarm names and metric values.
  A customer-managed KMS key would work but costs $1/month. TLS is still enforced.
- **Powertools rather than `console.log` with hand-rolled JSON.** It gives consistent fields
  (request id, cold start, service), metric validation, and tracing in a few lines, and AWS
  maintains it.

### Interview questions

1. **What is Embedded Metric Format, and why use it?** It's a JSON log structure that
   CloudWatch turns into metrics asynchronously. Lambdas emit metrics just by logging, with no
   `PutMetricData` calls, no added latency, and no extra IAM permissions.
2. **Why `treatMissingData: notBreaching`?** No traffic means no data points. For this pipeline
   idle is healthy, so missing data shouldn't count as a failure.
3. **How would you investigate a `queue-backlog-age` alarm?** Check the dashboard for
   processor errors or throttles and DynamoDB throttling. Open X-Ray traces for slow
   invocations. Check the DLQ. Finally, check whether `maxConcurrency` (5) is simply too low for
   the current load.
4. **Why alert on the DLQ at any message, not a percentage?** A message in the DLQ means an
   event failed 3 times and is out of the normal flow. Someone needs to look at it whatever the
   volume.
