# Security

What the pipeline protects, how, and what to add for production. Every control in the first
table is enforced in code and pinned by a test, so a change that weakens one fails CI.

## Threat model

| Threat                                                        | Likelihood here                                 |
| ------------------------------------------------------------- | ----------------------------------------------- |
| Producer API key extracted from a game client                 | **High**: anything shipped to players is public |
| Abuse or a retry loop running up the bill                     | Medium                                          |
| Malformed or oversized input crashing or slowing the pipeline | Medium                                          |
| Reading other players' stats or revenue                       | Medium if keys are shared                       |
| Stolen AWS credentials (CI or laptop)                         | Low, high impact                                |
| Vulnerable dependency inside a Lambda                         | Medium over time                                |

## Controls in place

| Control                                                                                                                                                                 | Where                                   | Test                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------- |
| **Separate ingest and stats APIs, each with its own key.** The producer key can only `POST /events`. It can't read stats or revenue.                                    | `eventstream-stack.ts`                  | `tests/infra/ingest.test.ts`            |
| Per-key rate limit and **daily quota** that bound what a leaked key can cost                                                                                            | `constructs/api.ts`, `DEFAULT_*_LIMITS` | `ingest.test.ts`                        |
| Every event validated with zod (strict payloads, unknown keys rejected, size caps); invalid events counted and rejected                                                 | `packages/schema`, `services/ingest`    | `tests/services/ingest/*`, schema tests |
| Request bodies over 1 MiB rejected with 413 before parsing                                                                                                              | `validate-request.ts`                   | `ingest.test.ts`                        |
| Request bodies and API keys never logged; only event ids, types and counts                                                                                              | handlers                                | code review                             |
| 500 responses never include internal error text                                                                                                                         | `services/query/src/handler.ts`         | `stats-reader.test.ts`                  |
| Least-privilege IAM per Lambda (ingest: send to the queue only; processor: Put/Update/ConditionCheck and Firehose put only; query: GetItem/BatchGetItem only)           | `eventstream-stack.ts`                  | exact action lists in `tests/infra/*`   |
| S3: all public access blocked, encryption, TLS-only bucket policy                                                                                                       | `constructs/archive.ts`                 | `archive.test.ts`                       |
| SQS: SSE, TLS-only queue policy. SNS: TLS-only. Firehose: encrypted at rest                                                                                             | constructs                              | infra tests                             |
| No long-lived AWS keys in CI: GitHub OIDC, a trust policy with an exact repo + environment match, 1-hour sessions, and the role can only assume the CDK bootstrap roles | `github-oidc-stack.ts`                  | `github-oidc-stack.test.ts`             |
| CI is read-only and never deploys; deploys only from `main` in the `dev` environment                                                                                    | workflows                               | `tests/ci/workflows.test.ts`            |
| `npm audit` fails CI on high-severity advisories in runtime dependencies; Dependabot sends weekly updates                                                               | `ci.yml`, `.github/dependabot.yml`      | `workflows.test.ts`                     |
| No account ids, emails or keys in code; all come from CDK context or the environment                                                                                    | `infra/lib/config.ts`                   | `budget-stack.test.ts`                  |
| Cost tripwires: $5 budget, alarm on reject rate, DLQ, backlog                                                                                                           | `budget-stack.ts`, `monitoring.ts`      | infra tests                             |

### About API keys

API Gateway API keys **identify and throttle callers; they are not strong authentication**.
That's acceptable for the ingest API, because its key is public anyway. The protection is that
the key can only _add_ events, through strict validation, inside a quota. It's not enough
protection for data people care about. That's why the stats API has its own key that never
ships to clients. For real dashboards, see "IAM auth for stats" below.

## Optional hardening (not enabled)

These cost money or change account-wide settings, so turning them on is your call.

| Option                                          | Why                                                                                                                                                                                                                                                                                                                                                | Cost / impact                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Scoped CDK execution policy**                 | By default, the CloudFormation role created by `cdk bootstrap` has `AdministratorAccess`, so anything that can deploy can do anything. Bootstrap with a policy limited to the services this stack uses: `npx cdk bootstrap --cloudformation-execution-policies arn:aws:iam::<account>:policy/eventstream-cfn-exec` (you create that policy first). | Free; you maintain the policy as the stack grows                 |
| **IAM auth for the stats API**                  | Replace the stats key with SigV4 (`authorizationType: IAM`), so only principals with `execute-api:Invoke` can read stats.                                                                                                                                                                                                                          | Free; callers need AWS credentials (`curl --aws-sigv4`)          |
| **AWS WAF on the ingest API**                   | Rate-based rules per IP, and AWS managed rule sets against bad bots.                                                                                                                                                                                                                                                                               | ~$5/month + $1 per rule + $0.60 per million requests             |
| **API Gateway access logs**                     | An audit trail of who called what (IP, key id, status), with no bodies.                                                                                                                                                                                                                                                                            | Requires the account-wide API Gateway CloudWatch role; ~$0.50/GB |
| **Customer-managed KMS keys**                   | Your own key policy and audit trail for S3, SQS, DynamoDB and SNS encryption.                                                                                                                                                                                                                                                                      | $1/month per key + API calls                                     |
| **GuardDuty**                                   | Detects compromised credentials and unusual API activity account-wide.                                                                                                                                                                                                                                                                             | Free for 30 days, then usage-based                               |
| **Pin GitHub Actions to commit SHAs**           | Protects against a compromised action tag. Dependabot updates the SHAs.                                                                                                                                                                                                                                                                            | Free                                                             |
| **Required reviewers on the `dev` environment** | Every deploy waits for your approval (docs/setup-cicd.md).                                                                                                                                                                                                                                                                                         | Free                                                             |

## Account hygiene (do once)

- MFA on the root user, and stop using root (docs/setup-aws.md).
- Use IAM Identity Center users, not IAM users with access keys.
- Keep the $5 budget deployed even when the pipeline is destroyed.
