# Milestone 5: Archive

**Status:** done (2026-10-13). Code-complete and tested; you deploy it yourself.

## Scope

The processor sends every processed event to Data Firehose. Firehose buffers events, converts
JSON to Parquet using a Glue table's schema, and writes to S3 under `events/dt=YYYY-MM-DD/`.
A Glue table with partition projection makes the data queryable in Athena. An Athena workgroup
caps the bytes each query can scan and comes with five saved queries.

## Done when

- [x] Unit tests: archive record mapping (UTC normalisation, JSON payload), Firehose batch
      limits (500 records / 4 MiB), per-record failure detection, and a test that the record
      fields exactly match the Glue columns.
- [x] CDK assertions: bucket public access blocked, encryption, TLS-only access, auto-delete
      on destroy; Firehose Parquet conversion via the Glue table with daily prefix and 1-week
      logs; Glue partition projection; Athena 1 GB scan cap; one named query per SQL file.
- [x] `cdk synth` passes CDK's default CloudFormation validation rules.

## Querying

In the Athena console, choose the **eventstream** workgroup, then **Saved queries**. The SQL
lives in [`infra/sql/`](../../infra/sql):

| Query                     | Answers                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `01-daily-active-players` | Distinct players and events per day (DAU)                             |
| `02-revenue-by-day`       | Purchases and revenue per day and currency                            |
| `03-top-players-by-kills` | 7-day kill leaderboard with win rate                                  |
| `04-client-clock-skew`    | p50 and p99 gap between client `occurred_at` and server `received_at` |
| `05-duplicate-rate`       | How many archived rows are redeliveries                               |

Files land in S3 within about 5 minutes (the Firehose buffer interval), so a fresh load test
shows up in Athena after that.

---

## Explanation

### What was built

| File                                | Role                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `services/processor/src/archive.ts` | `toArchiveRecord` (flat row), `batchForFirehose`, `sendToArchive`.                    |
| `infra/lib/constructs/archive.ts`   | Bucket, Glue database and table, Firehose stream, Athena workgroup and saved queries. |
| `infra/sql/*.sql`                   | Saved Athena queries, loaded into `CfnNamedQuery` at synth time.                      |

### How it works

1. After a batch is applied to DynamoDB, the processor calls `PutRecordBatch` with one JSON
   line per event. Firehose can reject single records inside a successful call, so the code
   checks every `RequestResponses[i].ErrorCode`. Rejected events mark their SQS message as
   failed, and that message is retried.
2. Firehose buffers records for up to 5 minutes or 64 MiB, whichever comes first. It then
   converts the batch to **Parquet**, a columnar, compressed format, using the column types
   from the Glue table, and writes one object per buffer flush.
3. The object key prefix `events/dt=!{timestamp:yyyy-MM-dd}/` uses the arrival date. That's
   Hive-style partitioning: a query with `WHERE dt >= '2026-10-01'` reads only those folders.
4. **Partition projection** tells Athena that `dt` is a date from 2026-01-01 to today, and
   how to build each partition's S3 path. No Glue crawler or `MSCK REPAIR TABLE` is needed when
   a new day appears.
5. The payload is stored as a JSON string. One table holds every event type and every schema
   version, and queries use `json_extract_scalar(payload, '$.price_cents')`.

### Design choices

- **Parquet rather than raw JSON.** Athena bills $5 per TB scanned. Parquet stores each
  column separately and compresses it, so a query that reads three columns scans a fraction
  of the bytes JSON would need. Converting costs Firehose about $0.018/GB, much less than it
  saves on repeated queries.
- **Arrival-date partitions, not event-date.** Dynamic partitioning on `occurred_at` is
  possible but costs extra per GB and per object. Untrusted client clocks could also scatter
  writes across old partitions. Each row still has `event_date` for reporting by when things
  happened.
- **Duplicates are tolerated in the archive.** If DynamoDB succeeded but Firehose failed, the
  retry archives the event again, which is the only way to close the gap. Queries use
  `SELECT DISTINCT event_id …`, and `05-duplicate-rate` measures how often it happens. This is
  at-least-once delivery with de-duplication at read time.
- **Cost guards.** A 1 GB scan cap per query, a 7-day expiry on Athena results, a 30-day expiry
  on Firehose error output, and `autoDeleteObjects` so `cdk destroy` leaves no billable
  objects behind.
- **Firehose versus writing to S3 directly from Lambda.** Many tiny S3 objects make Athena
  slow, and S3 charges per PUT request. Firehose batches into large files and does the Parquet
  conversion for you.

### Interview questions

1. **Why Parquet, and why partition by date?** Parquet is columnar and compressed, so Athena
   reads only the columns and row groups a query needs. Date partitions let `WHERE dt …` skip
   entire folders. Both reduce bytes scanned, which is what Athena bills for.
2. **What is partition projection?** Table properties describe the partition values and the
   path template, so Athena computes partitions at query time instead of looking them up in
   the Glue catalog. New partitions are visible immediately, with no crawler to run or pay for.
3. **Your archive can contain duplicates. Is that a problem?** No, because it's measured and
   handled. Writing to two systems (DynamoDB and Firehose) can't be made atomic, so the design
   picks at-least-once delivery to the archive and de-duplicates by `event_id` in queries.
   Dropping events would be worse than duplicating them.
4. **Why does Firehose need the Glue table?** Converting JSON to Parquet needs a schema with
   column names and types. Firehose reads it from the Glue Data Catalog, which is the same
   table Athena queries, so the writer and reader share one definition.
