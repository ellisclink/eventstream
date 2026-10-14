# Milestone 0: Project setup

**Status:** done (2026-10-12)

## Scope

The repo skeleton, with no pipeline logic yet.

1. The planned folder layout (see docs/architecture.md) as one npm project: TypeScript strict mode, with a path alias
   so services and tools can import `packages/schema`.
2. CDK v2 app in `infra/` with an empty `EventstreamStack`, tagged `project=eventstream`, that
   reads account and region from the CDK environment.
3. A separate `BudgetStack`: AWS Budgets monthly cost budget of $5, emailing an address passed
   in through CDK context.
4. `packages/schema`: the event envelope as a zod schema, plus exported TypeScript types.
   Payload schemas are placeholders.
5. Jest for TypeScript: envelope tests (a valid event passes, a missing `event_id` fails) and a
   CDK assertions test for the project tag.
6. ESLint and Prettier, with npm scripts `lint`, `format`, `test`, `synth`.
7. `.github/workflows/ci.yml`: runs on push and pull request with Node 22, `npm ci`, lint, test,
   and `cdk synth`. No deploy.
8. `.gitignore` and a README stub.
9. `docs/setup-aws.md`: `aws configure sso`, `cdk bootstrap`, then deploy only BudgetStack.

## Done when

- [x] `npm run lint`, `npm test` and `npx cdk synth` all pass.
- [x] The author can follow `docs/setup-aws.md` to deploy BudgetStack. Nothing was deployed for
      them.

---

## Explanation

### What was built

| File                                  | Role                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `package.json`                        | One npm project. Scripts: `typecheck`, `lint`, `format`, `format:check`, `test`, `synth`, `check`. |
| `tsconfig.json`                       | Strict TypeScript, plus the `@eventstream/schema` path alias.                                      |
| `eslint.config.mjs`                   | ESLint flat config with type-aware `typescript-eslint` rules. Prettier owns formatting.            |
| `.prettierrc.json`, `.prettierignore` | Formatting rules.                                                                                  |
| `jest.config.js`                      | Jest via `ts-jest`, with the same alias as tsconfig.                                               |
| `packages/schema/src/event-types.ts`  | The six event types and `SCHEMA_VERSION`.                                                          |
| `packages/schema/src/payloads.ts`     | One payload schema per event type (placeholders that require an object).                           |
| `packages/schema/src/envelope.ts`     | `envelopeSchema`, `eventSchema` (discriminated union), `parseEvent`, inferred types.               |
| `packages/schema/src/index.ts`        | The package's public surface.                                                                      |
| `infra/bin/eventstream.ts`            | CDK entry point: reads config, builds the app.                                                     |
| `infra/lib/config.ts`                 | Reads and validates context (`budgetEmail`, `budgetLimitUsd`) and the CDK env vars.                |
| `infra/lib/app.ts`                    | `buildApp()`: tags and creates the stacks. Used by both the CLI and the tests.                     |
| `infra/lib/eventstream-stack.ts`      | Empty pipeline stack.                                                                              |
| `infra/lib/budget-stack.ts`           | `AWS::Budgets::Budget` with 80% actual and 100% forecast email alerts.                             |
| `infra/lib/tags.ts`                   | The `project=eventstream` tag constant.                                                            |
| `cdk.json`                            | Tells the CDK CLI how to run the app (`tsx`), plus recommended feature flags.                      |
| `tests/packages/schema/*.test.ts`     | 27 schema tests.                                                                                   |
| `tests/infra/*.test.ts`               | CDK assertion tests for both stacks and the config reader.                                         |
| `tests/infra/cdk-context.ts`          | Loads `cdk.json` context so tests synthesize the same way the CLI does.                            |
| `.github/workflows/ci.yml`            | CI: typecheck, lint, format check, test, synth.                                                    |
| `docs/setup-aws.md`                   | Step-by-step AWS sign-in and first deploy.                                                         |

### How it works

**Path alias.** `tsconfig.json` maps `@eventstream/schema` to `packages/schema/src/index.ts`.
TypeScript only uses this mapping for type checking and does not rewrite import paths in its
output. Every tool that runs the code therefore needs the same mapping. Jest gets it through
`moduleNameMapper`. `tsx`, which runs the CDK app, and esbuild, which will bundle the Lambdas
through `NodejsFunction`, both read `paths` from tsconfig on their own. The result is one
package that every part of the codebase imports by name, with no build step and no npm
workspaces.

**zod schema and inferred types.** `eventSchema` is a _discriminated union_ on `event_type`.
zod reads `event_type` first and validates only the matching variant, so errors refer to that
event type instead of listing failures from all six. `z.infer<typeof eventSchema>` produces the
TypeScript type from the schema, which keeps the runtime check and the compile-time type from
drifting apart. `EventOf<'purchase'>` uses `Extract` to narrow the union to a single variant.
`parseEvent` wraps `safeParse`, which returns a result instead of throwing, and turns issues
into `path: message` strings. The ingest Lambda can count and log those strings without
logging the raw request body, which the project's security rules forbid (docs/security.md).

**CDK app.** `cdk synth` runs `npx tsx infra/bin/eventstream.ts`. The entry point creates an
`App`, reads the config, and calls `buildApp`. Before running the app, the CDK CLI sets
`CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` from the active AWS profile. `readConfig` passes
those values through as the stack `env`. Without credentials, as in CI, they are unset and the
stacks synthesize _environment-agnostic_, so the same code works locally, in CI, and against
any account.

**Tags.** `Tags.of(app).add(...)` attaches a CDK _aspect_. During synthesis the aspect visits
every construct and tags each one that supports tags. Stack-level tags are also passed
explicitly, because the recommended flag `@aws-cdk/core:explicitStackTags` turns off
`Tags.of()` for stacks. CloudFormation copies stack tags onto every resource it creates.
`CfnBudget` isn't taggable through the aspect, so its `resourceTags` are set directly.

**Budget.** `CfnBudget` is an L1 construct, a one-to-one mapping of the CloudFormation resource
`AWS::Budgets::Budget`. No higher-level L2 construct exists for it. The email comes from
`-c budgetEmail=...` and is validated with zod. When the email is missing, the app skips
BudgetStack and prints a warning, so a plain `npx cdk synth` still passes.

**Tests.** CDK `assertions` synthesizes a stack to a CloudFormation template in memory. Calls
like `hasResourceProperties` then check that template, with no AWS access. The tests load the
feature flags from `cdk.json`, because those flags change what gets synthesized. During this
milestone, a tag test passed against the defaults while the real synth had dropped the stack
tags.

### Design choices

- **One npm project with path aliases, not npm workspaces.** There's one shared package and
  everything deploys together, so workspaces would only add per-package `package.json` files
  and build ordering. Tradeoff: the schema can't be published or versioned on its own. That's
  fine for a single deployable repo.
- **BudgetStack separate from EventstreamStack.** The budget can be deployed first, before
  anything costs money, and stays in place while the pipeline stack is destroyed and
  redeployed. Budgets are free for the first two per account.
- **Email skipped when missing, not hardcoded and not a hard error.** Hardcoding would leak a
  personal address into git and break the rule about account-specific values. Failing synth
  when it's missing would break CI and the plain `npx cdk synth` check. CI passes a placeholder
  email so the budget template is still checked on every push.
- **80% actual plus 100% forecast alerts.** A single 100% actual alert arrives after the money
  is already spent. Once AWS has about five weeks of history to forecast from, the forecast
  alert usually fires earlier. Until then the 80% actual alert is the early warning.
- **zod rather than JSON Schema or hand-written checks.** One definition gives both runtime
  validation and static types, and the same schema will be shared by the Lambdas and the load
  generator. Tradeoff: zod adds tens of kilobytes to each Lambda bundle (to be measured in Milestone 8).
- **`tsx` to run the CDK app.** It's faster than `ts-node` and honors tsconfig paths without
  extra setup.
- **Recommended CDK feature flags turned on now.** Flags change synthesized output, so turning
  them on later could replace resources. In an empty project they cost nothing. Two
  non-boolean flags (`defaultCrossStackReferences`, `target-partitions`) are left at their
  defaults, which is why synth still reports "2 feature flags are not configured".

### Interview questions

1. **Why validate with zod at runtime when you already have TypeScript types?**
   TypeScript types disappear at compile time. A request body is just untrusted JSON at
   runtime, and only a runtime check can reject it. zod gives the runtime check and derives the
   type from it, so the two can't disagree.

2. **What's the difference between `cdk synth` and `cdk deploy`?**
   `synth` runs the CDK app and writes CloudFormation templates to `cdk.out/` locally, without
   calling AWS. `deploy` synthesizes, uploads assets to the bootstrap bucket, and asks
   CloudFormation to create or update the stack. CI runs only `synth`, which proves the
   infrastructure code is valid without any credentials.

3. **What does `cdk bootstrap` create, and why is it needed?**
   A `CDKToolkit` CloudFormation stack containing an S3 bucket and an ECR repository for assets
   (Lambda bundles and container images) and IAM roles the CLI assumes to deploy. Deployments
   need somewhere to upload assets and a role with permission to run CloudFormation.

4. **How do you keep account IDs and emails out of the code?**
   Account and region come from `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION`, which the CLI
   sets from the signed-in profile. The email comes from CDK context on the command line.
   Credentials come from short-lived IAM Identity Center sessions, so no access keys exist to
   leak.

5. **What is an L1 construct, and why is the budget one?**
   L1 (`Cfn*`) constructs map directly onto CloudFormation resources. L2 constructs add
   defaults and helper methods such as `grant*`. AWS Budgets has no L2 construct, so the code
   uses `CfnBudget` and sets the properties exactly as CloudFormation defines them.
