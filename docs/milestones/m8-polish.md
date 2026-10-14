# Milestone 8: Polish

**Status:** done as code and docs (2026-10-13). The measured load-test and cost numbers are
filled in by you after a deployed run. The tables are ready in
[cost-and-load.md](../cost-and-load.md).

## Scope

- README rewritten as the project's front page: what it is, highlights, quick start, API, and
  links to the docs.
- [architecture.md](../architecture.md): a Mermaid diagram (rendered by GitHub), the request
  lifecycle, delivery guarantees, stacks, and layout.
- [demo.md](../demo.md): a 15-minute live walkthrough that deploys, sends load, queries,
  proves idempotency, and queries Athena.
- [cost-and-load.md](../cost-and-load.md): idle cost, a cost model per million events,
  throughput limits, a load-test plan, and a results table.
- `npm run stack-info`: reads the stack outputs and the API key value, and prints shell
  `export` lines so the load generator is configured in one command.
- `setup-aws.md` extended with deploying and tearing down the pipeline.

## Done when

- [x] `npm run check` passes.
- [x] Unit tests for `stack-info` output parsing and shell quoting.
- [ ] _(You)_ Load-test table filled in from a deployed run.
- [ ] _(You)_ Cost per million events confirmed in Cost Explorer.

---

## Explanation

### Design choices

- **Mermaid instead of an image.** The diagram lives as text next to the code, shows up in
  diffs, and GitHub renders it. A PNG would go stale silently.
- **Estimates labelled as estimates.** Every cost figure is derived from list prices and the
  design. The doc says how to replace each one with a measured figure. An interviewer will ask
  where numbers came from.
- **A key-printing helper, not a key in outputs.** CloudFormation outputs are visible to anyone
  with read access to the stack, so the key _value_ never goes there. `stack-info` reads it on
  demand with your own credentials and only prints it when you ask with `--export`.

### Interview questions

1. **What does this pipeline cost, and what dominates?** About $0.05/month idle, and an
   estimated $2.70–$4.90 per million events. Most of that is DynamoDB transactional writes,
   the price of exactly-once counting. Grouping each player's events into one transaction per
   batch cut write units by 19–60%, depending on traffic shape. The cost doc lists further
   options and their tradeoffs.
2. **Where is the bottleneck?** The processor: 5 concurrent invocations × 100 events per batch
   is about 250 events/s. Ingest keeps accepting above that, and the queue absorbs the excess.
   The backlog-age alarm and the ingest-to-processed delay metric show it, and raising
   `maxConcurrency` fixes it.
3. **How would you show this system working in five minutes?** Run `docs/demo.md` steps 3, 4
   and 6: reject a bad event precisely, run load with the dashboard open, then send the same
   batch twice and show the counters don't move.
