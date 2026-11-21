# AWS setup: sign-in, bootstrap, and the first deploy

This guide takes you from a fresh AWS account to a deployed **BudgetStack**, which is the
$5/month cost alert. Do it before deploying anything that can cost money. You run every
command yourself. Nothing in this repo deploys automatically.

Commands are shown for PowerShell on Windows. Where bash differs, the bash form follows.

---

## 0. Before you start

- An AWS account you own. Sign in as the **root user** only for step 2 and the billing-access
  fix in Troubleshooting, and protect it with MFA (Account menu → Security credentials →
  Assign MFA).
- Node.js 22.13+, and `npm ci` run in this repo.
- The repo passes locally: `npm run check`.

## 1. Install the AWS CLI v2

```powershell
winget install Amazon.AWSCLI
```

Close and reopen the terminal, then check it:

```powershell
aws --version   # expect aws-cli/2.x
```

(macOS: `brew install awscli`. Linux: see the AWS CLI v2 install guide.)

## 2. Create an SSO user in IAM Identity Center (one time, in the console)

IAM Identity Center gives you short-lived credentials through a browser sign-in, so no
long-lived access keys sit on your disk. This is the only console setup in the project. It
manages _who can sign in_. AWS resources are always created through CDK.

1. Switch the console's region selector (top right) to the region you plan to use, for
   example `us-east-1` or `eu-west-2`. Identity Center lives in whichever region is selected
   when you enable it. Open **IAM Identity Center** and choose **Enable** with **AWS
   Organizations** (the organization instance). Do not pick an _account instance_, which
   cannot grant access to AWS accounts. Enabling it creates an AWS Organization with your
   account as the management account. That is expected and free.
2. **Users → Add user**: create a user for yourself with your email. Accept the invite email
   and set a password and MFA.
3. **Permission sets → Create permission set → Predefined → AdministratorAccess**. Keep the
   session duration at 1 to 4 hours. CDK bootstrap creates IAM roles, so this personal
   learning account needs admin. In a team account you would use a narrower set.
4. **AWS accounts →** select your account **→ Assign users or groups →** your user **→** the
   `AdministratorAccess` permission set.
5. On the IAM Identity Center **Dashboard**, copy the **AWS access portal URL**. It looks like
   `https://d-xxxxxxxxxx.awsapps.com/start`.

## 3. Configure the CLI with `aws configure sso`

```powershell
aws configure sso
```

Answer the prompts:

| Prompt                  | Answer                                       |
| ----------------------- | -------------------------------------------- |
| SSO session name        | `eventstream`                                |
| SSO start URL           | the access portal URL from step 2.5          |
| SSO region              | the region where you enabled Identity Center |
| SSO registration scopes | press Enter to accept `sso:account:access`   |

A browser opens. Sign in as your Identity Center user and choose **Allow**. Back in the
terminal:

| Prompt                    | Answer                                            |
| ------------------------- | ------------------------------------------------- |
| Account                   | your account (selected automatically if only one) |
| Role                      | `AdministratorAccess`                             |
| Default client Region     | the region to deploy into, e.g. `eu-west-2`       |
| CLI default output format | `json`                                            |
| Profile name              | `eventstream-dev`                                 |

This writes the profile to `~/.aws/config`. No secrets go into this repo.

Check that it works:

```powershell
aws sts get-caller-identity --profile eventstream-dev
```

You should see your 12-digit account ID and an ARN containing `AWSReservedSSO_AdministratorAccess`.

Make it the default profile for this terminal, so you don't need `--profile` on every
command:

```powershell
$env:AWS_PROFILE = "eventstream-dev"
```

```bash
export AWS_PROFILE=eventstream-dev
```

When the session expires (you see "Token has expired" or "SSO session ... is invalid"), sign
in again:

```powershell
aws sso login --profile eventstream-dev
```

## 4. Bootstrap CDK (one time per account and region)

`cdk bootstrap` deploys a CloudFormation stack named **CDKToolkit**. It holds an S3 bucket
and an ECR repository for deployment assets, plus IAM roles that the CDK CLI assumes to
deploy. At this project's size it costs a few cents a month at most.

Find your account ID and region:

```powershell
$account = aws sts get-caller-identity --query Account --output text
$region  = aws configure get region
```

```bash
account=$(aws sts get-caller-identity --query Account --output text)
region=$(aws configure get region)
```

Bootstrap the account and region:

```powershell
npx cdk bootstrap "aws://$account/$region"
```

The CLI prints the IAM changes and finishes with `Environment aws://.../... bootstrapped`.
If you see "BudgetStack skipped" during this step, that's expected, because no email was
passed.

## 5. Preview the BudgetStack

The alert email comes from CDK context (`-c budgetEmail=...`). It is never written in the
code, and you pass it on the command line each time. Replace `you@example.com` with your
real address in the commands below.

```powershell
npx cdk synth BudgetStack -c budgetEmail=you@example.com
npx cdk diff  BudgetStack -c budgetEmail=you@example.com
```

`synth` prints the CloudFormation template. Check for one `AWS::Budgets::Budget` with
`Amount: 5`, `Unit: USD`, `TimeUnit: MONTHLY`, and your email under `Subscribers`. `diff`
shows what would change in your account. On the first run, everything is new.

## 6. Deploy only the BudgetStack

Name the stack explicitly. **Do not use `--all` yet.**

```powershell
npx cdk deploy BudgetStack -c budgetEmail=you@example.com
```

The CLI only stops to ask `Do you wish to deploy these changes (y/n)?` when a deploy adds
IAM or security-group changes. BudgetStack has none, so it deploys straight away and
finishes with `✅ BudgetStack`.

What you get:

- A monthly cost budget named `eventstream-monthly-cost` with a $5 limit.
- An email when **actual** spend passes 80% ($4).
- An email when **forecasted** month-end spend passes 100% ($5).

Budget emails go straight to the address and need no subscription confirmation. They can
arrive several hours after spend crosses a threshold, because AWS updates billing data a
few times a day. On a new account, AWS needs about five weeks of spending history before it
can forecast, so at first the 80% actual-spend alert is the one that protects you.

The default limit is 5 USD. To change it, add `-c budgetLimitUsd=10` to the command.

## 7. Verify

In a new terminal, set `$account` again first (step 4).

```powershell
aws budgets describe-budgets --account-id $account --query "Budgets[].[BudgetName,BudgetLimit.Amount,BudgetLimit.Unit]"
```

Expected output: `eventstream-monthly-cost`, `5.0`, `USD`. You can also see the budget in
the console under **Billing and Cost Management → Budgets**.

## 8. Deploy the pipeline

With the budget in place, deploy the pipeline itself: the API, Lambdas, queue, table,
archive and monitoring. Passing an alert email is optional.

```powershell
npx cdk deploy EventstreamStack -c alertEmail=you@example.com
```

This time the CLI **does** ask for confirmation, because the stack creates IAM roles. Review
the list and type `y`. The first deploy takes about 3 to 5 minutes. Then:

- If you passed `alertEmail`, confirm the SNS subscription email.
- Follow [demo.md](demo.md) to send traffic and query the results.

When an idle pipeline has no traffic it costs close to nothing. Remove it when you're done for
the day, or keep it, since idle cost is cents. See [cost-and-load.md](cost-and-load.md).

```powershell
npx cdk destroy EventstreamStack
```

## 9. Later: removing everything

```powershell
npx cdk destroy EventstreamStack
npx cdk destroy BudgetStack -c budgetEmail=you@example.com
```

Every resource uses `RemovalPolicy.DESTROY`, and the archive bucket empties itself, so
nothing meaningful is left behind. A couple of small CloudWatch log groups created outside
CDK, such as the bucket-emptying helper's log group, can remain. They cost fractions of a
cent; delete them in the CloudWatch console if you want a fully clean account. The `CDKToolkit` bootstrap stack stays until you delete it in
CloudFormation. It costs cents a month.

---

## Troubleshooting

| Symptom                                                         | Fix                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Unable to resolve AWS account to use`                          | `$env:AWS_PROFILE` is not set in this terminal, or the SSO session expired: run `aws sso login`. |
| `SSOTokenProviderFailure` / `Token has expired`                 | `aws sso login --profile eventstream-dev`                                                        |
| `This stack uses assets, so the toolkit stack must be deployed` | Run step 4 for this account and region.                                                          |
| `No stacks match the name(s) BudgetStack`                       | You left out `-c budgetEmail=...`. Without it the app skips BudgetStack by design.               |
| `Context value "budgetEmail" must be a valid email address`     | Check the email for typos and extra quotes.                                                      |
| Budgets page in the console says access denied                  | As root: Account → _IAM user and role access to Billing information_ → Activate.                 |
| Alarm emails never arrive                                       | Click the link in the "AWS Notification - Subscription Confirmation" email first.                |
