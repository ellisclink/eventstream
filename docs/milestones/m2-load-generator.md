# Milestone 2: Load generator CLI

**Status:** done (2026-10-13)

## Scope

A CLI in `tools/loadgen` that simulates players and sends realistic event batches to
`POST /events` at a target rate. It reports accepted, rejected and failed counts, status
codes, and latency percentiles.

## Usage

```bash
# Print sample events without sending anything
npm run loadgen -- --dry-run --count 5 --seed 1

# Send ~50 events/s for 60 s, 5% deliberately invalid
export EVENTSTREAM_API_URL=https://<id>.execute-api.<region>.amazonaws.com/dev/
export EVENTSTREAM_API_KEY=$(aws apigateway get-api-key --api-key <LoadgenApiKeyId> --include-value --query value --output text)
npm run loadgen -- --rate 50 --duration 60 --invalid-ratio 0.05
```

`npm run loadgen -- --help` lists every option. The process exits with code 1 if any event
could not be delivered after retries, so a script can detect a failed run.

## Done when

- [x] Unit tests: generated events always pass the shared schema, player lifecycles are
      valid, runs are reproducible from a seed, corruption always fails validation, and the
      client's retry and backoff logic is covered.
- [x] End-to-end against a local server running the real `ingest()` logic: 600 events,
      ~12% rejected at `--invalid-ratio 0.1`, 0 failed. A wrong key gives 403s with no retries.

---

## Explanation

### What was built

| File                             | Role                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `tools/loadgen/src/random.ts`    | Seeded random number generator (mulberry32), plus reproducible UUIDs.                  |
| `tools/loadgen/src/generator.ts` | Per-player state machine that emits valid events; `corrupt()` breaks them on purpose.  |
| `tools/loadgen/src/client.ts`    | `postBatch`: POST with the API key, backoff on 429/5xx, resend of failed indexes only. |
| `tools/loadgen/src/runner.ts`    | Open-loop scheduler, in-flight cap, latency percentiles.                               |
| `tools/loadgen/src/args.ts`      | Option parsing with `node:util` `parseArgs`, range checks, endpoint URL building.      |
| `tools/loadgen/src/cli.ts`       | Wires everything together and prints a JSON summary.                                   |

### How it works

- **State machine.** Each simulated player is `offline → lobby → in_match → post_match →
lobby … → offline`. Each step emits the matching event: `session_start`, `match_start`,
  `match_end`, then sometimes `level_up` or `purchase`, and finally `session_end`. Because
  the generator tracks state, a `match_end` always has a `match_start` with the same
  `match_id`, and levels only go up. Downstream aggregates therefore come out sensible.
- **Shared schema.** The generator builds `GameEvent` values, the type inferred from the
  zod schema. A payload with a wrong field won't compile, so the producer and the API can't
  drift apart.
- **Open-loop load.** Batches go out on a fixed schedule (`interval = 1000 × batchSize /
rate`) whether or not earlier ones have finished, with a cap on how many can be in flight.
  A closed-loop client waits for each response first, so a slow server quietly reduces the
  load and hides the slowdown. Open-loop makes it show up as higher latency.
- **Retries.** A 429 or 5xx backs off exponentially with jitter. On a 202, only the `failed`
  indexes are resent. Resending is safe because the processor deduplicates by `event_id`.

### Design choices

- **The API key comes only from an environment variable.** A `--api-key` flag would leave the
  key in shell history and in process listings that other users can read.
- **A seeded RNG instead of `Math.random`.** A seed reproduces the same run when you
  investigate a bug or compare before-and-after performance.
- **Built-in `fetch` and `parseArgs`.** Node 22 has both, so the CLI needs no extra packages.
- **Tradeoff:** a single Node process tops out at a few thousand events per second. That's
  plenty for this project's free-tier-sized tests. Higher loads would need several processes
  or a tool like k6.

### Interview questions

1. **Why open-loop instead of sending the next batch when the last one returns?** Closed-loop
   generators suffer from _coordinated omission_: when the server slows down, the client sends
   less and the measured latency looks better than reality. Open-loop holds the offered rate
   constant.
2. **How do you make a load test reproducible?** Seed the random number generator, so the same
   seed always produces the same players, actions and event ids.
3. **Is it safe to retry a request that may have partly succeeded?** Yes. Every event has a
   unique `event_id`, and the processor ignores ids it has already seen, so retries are
   idempotent.
4. **Why add jitter to backoff?** Without it, many clients throttled at the same moment would
   all retry at the same moment too and get throttled again. Jitter spreads the retries out.
