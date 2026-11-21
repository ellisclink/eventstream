# CI/CD setup: deploy from GitHub Actions with OIDC

After this one-time setup, every push to `main` runs the full CI checks and then deploys
`EventstreamStack` to your account. No AWS access keys are stored anywhere: GitHub and AWS
exchange a short-lived token on each run.

Complete [setup-aws.md](setup-aws.md) first. You need a working `eventstream-dev` profile and a
bootstrapped account.

## 1. Push the repo to GitHub

Create an empty repository, for example `your-name/eventstream`, then push:

```bash
git remote add origin https://github.com/your-name/eventstream.git
git push -u origin main
```

The **CI** workflow runs straight away. **Deploy** runs too, but skips its deploy job because
no role is configured yet.

## 2. Deploy the OIDC role (once, from your machine)

```bash
npx cdk deploy GithubOidcStack -c githubRepo=your-name/eventstream
```

This creates:

- The IAM OIDC identity provider for `token.actions.githubusercontent.com`.
- The role `eventstream-github-deploy`. It trusts only tokens from **your repo's `dev`
  environment**, and all it can do is assume the CDK bootstrap roles.

Copy the `DeployRoleArn` output.

If the deploy fails with `Provider with url https://token.actions.githubusercontent.com
already exists`, your account already has the provider. Reuse it:

```bash
aws iam list-open-id-connect-providers
npx cdk deploy GithubOidcStack -c githubRepo=your-name/eventstream -c githubOidcProviderArn=<that ARN>
```

## 3. Configure the repository

In GitHub, go to **Settings → Environments → New environment** and name it `dev`. Optionally
add yourself under **Required reviewers**. Every deploy then waits for you to click
**Approve**.

Then go to **Settings → Secrets and variables → Actions → Variables** and add:

| Variable              | Value                                                           |
| --------------------- | --------------------------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN` | the `DeployRoleArn` output                                      |
| `AWS_REGION`          | your region, e.g. `eu-west-2`                                   |
| `ALERT_EMAIL`         | optional: address for alarm emails (confirm the AWS email once) |

These are _variables_, not secrets, because none of them is sensitive. The role can only be
assumed by your repo's workflow.

## 4. Deploy

Push to `main`, or open **Actions → Deploy → Run workflow**. The run:

1. Runs the same checks as CI: typecheck, lint, format, tests, synth.
2. Exchanges the GitHub OIDC token for temporary AWS credentials.
3. Runs `cdk diff`, then `cdk deploy EventstreamStack`.
4. Smoke-tests that both APIs return **403** without an API key (`POST /events` on the ingest
   API, `GET /stats/...` on the stats API). That proves both are live and enforcing keys.

`BudgetStack` and `GithubOidcStack` are never deployed by CI. They change rarely, and
you deploy them yourself.

## Turning it off

Delete the `AWS_DEPLOY_ROLE_ARN` variable, and the deploy job is skipped. To remove the role
completely, run `npx cdk destroy GithubOidcStack -c githubRepo=your-name/eventstream`.
