# Demo: from zero to queryable data

A walkthrough to run end to end in about 15 minutes, or to show live in an interview.
It assumes [setup-aws.md](setup-aws.md) is done and `AWS_PROFILE` is set.

Commands are shown for bash. The PowerShell versions differ only where noted.

## 1. Deploy

```bash
npx cdk deploy EventstreamStack -c alertEmail=you@example.com
```

## 2. Point the load generator at it

```bash
eval "$(npm run -s stack-info -- --export bash)"
# PowerShell: npm run -s stack-info -- --export powershell | Invoke-Expression
```

This sets four variables for the current shell only:

- `EVENTSTREAM_API_URL` and `EVENTSTREAM_API_KEY` for the **ingest** API (the producer key).
- `EVENTSTREAM_STATS_URL` and `EVENTSTREAM_STATS_KEY` for the **stats** API (the reader key).

The producer key can't read stats. Step 5 shows this.

## 3. Show the API rejecting bad requests

```bash
# No key: API Gateway refuses before any Lambda runs
curl -s -o /dev/null -w '%{http_code}\n' -X POST "${EVENTSTREAM_API_URL}events" -d '{}'      # 403

# Valid key, one good event and one bad event: 202 with a precise rejection
npm run -s loadgen -- --dry-run --count 1 --seed 1 > /tmp/event.json
curl -s -X POST "${EVENTSTREAM_API_URL}events" \
  -H "x-api-key: ${EVENTSTREAM_API_KEY}" -H 'content-type: application/json' \
  -d "{\"events\": [$(cat /tmp/event.json), {\"event_type\": \"teleport\"}]}"
# {"accepted":1,"rejected":[{"index":1,"issues":["event_type: Invalid discriminator value ..."]}],"failed":[]}
```

## 4. Send load

```bash
npm run loadgen -- --rate 100 --duration 60 --players 50 --invalid-ratio 0.05 --seed 42
```

The summary shows accepted, rejected and failed counts, status codes, and p50/p95/p99
latency. Open **CloudWatch → Dashboards → eventstream** while it runs.

## 5. Query the aggregates (seconds later)

```bash
curl -s -H "x-api-key: ${EVENTSTREAM_STATS_KEY}" "${EVENTSTREAM_STATS_URL}stats/players/player-0001" | jq
curl -s -H "x-api-key: ${EVENTSTREAM_STATS_KEY}" "${EVENTSTREAM_STATS_URL}stats/daily/$(date -u +%F)" | jq

# The producer key is refused by the stats API
curl -s -o /dev/null -w '%{http_code}\n' -H "x-api-key: ${EVENTSTREAM_API_KEY}" "${EVENTSTREAM_STATS_URL}stats/daily/$(date -u +%F)"   # 403
```

## 6. Prove idempotency

Send the exact same batch twice. The second run is accepted again (202), but the counters
don't change:

```bash
npm run -s loadgen -- --dry-run --count 20 --seed 7 | jq -s '{events: .}' > /tmp/batch.json
for i in 1 2; do
  curl -s -X POST "${EVENTSTREAM_API_URL}events" -H "x-api-key: ${EVENTSTREAM_API_KEY}" \
    -H 'content-type: application/json' --data @/tmp/batch.json; echo
done
sleep 15   # the processor waits up to 10 s to fill a batch
curl -s -H "x-api-key: ${EVENTSTREAM_STATS_KEY}" "${EVENTSTREAM_STATS_URL}stats/daily/$(date -u +%F)" | jq .events
```

The **DuplicatesSkipped** metric on the dashboard goes up by 20.

## 7. Query the archive (about 5 minutes later)

In **Athena**, switch to the **eventstream** workgroup, open **Saved queries**, and run
`01-daily-active-players` or `05-duplicate-rate`. The duplicate rate shows the redelivered
rows from step 6, which `DISTINCT event_id` removes.

## 8. Tear down

```bash
npx cdk destroy EventstreamStack
```
