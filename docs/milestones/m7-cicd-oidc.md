# Milestone 7: CI/CD deploy with OIDC

**Status:** done (2026-10-13). Workflows and role are code-complete and tested. Follow
[docs/setup-cicd.md](../setup-cicd.md) to switch on deploys.

## Scope

- `GithubOidcStack`: the GitHub OIDC identity provider and a deploy role that trusts only this
  repo's `dev` environment and can only assume the CDK bootstrap roles.
- `.github/workflows/deploy.yml`: on push to `main`, run the full CI checks (by reusing
  `ci.yml`), then exchange the OIDC token for AWS credentials, run `cdk diff`, run
  `cdk deploy EventstreamStack`, and smoke-test.
- `ci.yml` became reusable (`workflow_call`), and its synth step now covers every stack.

## Done when

- [x] CDK assertions on the provider audience, the exact `sub` condition, a 1-hour session,
      the `sts:AssumeRole` scope limited to the bootstrap roles, and reuse of an existing
      provider.
- [x] Workflow tests (YAML parsed in Jest): CI is read-only and never deploys. Deploy needs
      the checks, runs in the `dev` environment with `id-token: write`, never references
      access keys, is skipped until configured, is never cancelled mid-run, deploys only
      `EventstreamStack`, and asserts the 403 smoke test.

---

## Explanation

### What was built

| File                             | Role                                                        |
| -------------------------------- | ----------------------------------------------------------- |
| `infra/lib/github-oidc-stack.ts` | OIDC provider and deploy role.                              |
| `infra/lib/config.ts`            | Validates `githubRepo` and `githubOidcProviderArn` context. |
| `.github/workflows/deploy.yml`   | Check, then deploy, then smoke test.                        |
| `.github/workflows/ci.yml`       | Same checks as before, now also callable by deploy.         |
| `tests/ci/workflows.test.ts`     | Security properties of the workflows, as tests.             |
| `docs/setup-cicd.md`             | One-time setup steps.                                       |

### How it works

1. A job with `permissions: id-token: write` can ask GitHub for a signed JWT. The token's
   `sub` claim describes where it came from, for example
   `repo:your-name/eventstream:environment:dev`.
2. `aws-actions/configure-aws-credentials` sends the token to AWS STS with
   `AssumeRoleWithWebIdentity`. STS checks the signature against the registered OIDC
   provider. It then checks the role's trust policy: the audience must be `sts.amazonaws.com`
   and the `sub` must match exactly. If both pass, it returns credentials valid for at most one
   hour.
3. The role's only permission is `sts:AssumeRole` on `cdk-hnb659fds-*-role-<account>-<region>`.
   `cdk deploy` uses those bootstrap roles to upload assets and run CloudFormation, exactly as
   it does from your laptop.

### Design choices

- **OIDC rather than access keys in GitHub secrets.** Stored keys never expire, can leak
  through logs or forks, and have to be rotated by hand. OIDC credentials last an hour and are
  issued only to the exact repo and environment named in the trust policy.
- **Trust the environment, not the branch.** A GitHub environment can require manual approval
  and limit which branches deploy to it. Matching `environment:dev` makes those protections
  part of the security boundary. The match is exact (`StringEquals`). A wildcard like
  `repo:x/*` would let any branch or workflow in the repo deploy.
- **Let CI assume only the bootstrap roles.** The bootstrap roles already define what CDK may
  do. Giving the GitHub role `AdministratorAccess` would work, but any compromised workflow
  could then do anything in the account.
- **Deploy only the pipeline stack.** The budget and the OIDC role are guard rails. If CI could
  change them, a bad commit could remove the very controls that limit it.
- **Smoke test without secrets.** Checking that an unauthenticated call gets a 403 proves the
  deploy worked and auth is enforced, without giving CI permission to read API keys.

### Interview questions

1. **How does GitHub Actions authenticate to AWS without stored credentials?** Through OIDC
   federation. GitHub issues a signed token, AWS STS verifies it against the registered
   provider and the role's trust conditions, and returns temporary credentials.
2. **What stops another repository from using your role?** The trust policy requires
   `sub = repo:<owner>/<repo>:environment:dev` exactly. Tokens from other repos, forks or
   environments carry a different `sub`.
3. **Why does the deploy job say `concurrency: cancel-in-progress: false`?** Cancelling a
   CloudFormation deployment halfway triggers a rollback and can leave the stack stuck in a
   slow state. Queuing the next deploy is safer.
4. **What would you add for production?** A separate prod account and environment with
   required reviewers, deploying the same build artifact promoted from dev, a post-deploy
   load-test gate, and automatic rollback on alarms.
