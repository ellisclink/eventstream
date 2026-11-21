import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import {
  Effect,
  OidcProviderNative,
  PolicyStatement,
  Role,
  WebIdentityPrincipal,
  type IOidcProvider,
} from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
/** The GitHub environment the deploy job runs in; the role trusts only this environment. */
export const DEPLOY_ENVIRONMENT = 'dev';

export interface GithubOidcStackProps extends StackProps {
  /** "owner/repo" allowed to deploy. */
  readonly githubRepo: string;
  /** An account can hold one provider per URL; pass its ARN to reuse an existing one. */
  readonly existingProviderArn?: string | undefined;
}

/**
 * Lets GitHub Actions deploy without stored AWS keys. GitHub issues the workflow a
 * short-lived OIDC token; AWS STS exchanges it for temporary credentials for this role,
 * but only if the token says it came from the given repo's `dev` environment.
 *
 * The role can do exactly one thing: assume the CDK bootstrap roles. Those already hold
 * the permissions `cdk deploy` needs, so CI gets no broader access than a local deploy.
 */
export class GithubOidcStack extends Stack {
  readonly role: Role;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const provider: IOidcProvider =
      props.existingProviderArn === undefined
        ? new OidcProviderNative(this, 'GithubProvider', {
            url: GITHUB_OIDC_URL,
            clientIds: ['sts.amazonaws.com'],
          })
        : OidcProviderNative.fromOidcProviderArn(this, 'GithubProvider', props.existingProviderArn);

    this.role = new Role(this, 'DeployRole', {
      roleName: 'eventstream-github-deploy',
      description: `GitHub Actions deploys for ${props.githubRepo} (${DEPLOY_ENVIRONMENT})`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // Exact match, not a wildcard: forks, other branches' jobs and other repos can't
          // assume this role. The environment can additionally require a manual approval.
          'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:environment:${DEPLOY_ENVIRONMENT}`,
        },
      }),
    });

    this.role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        // Default bootstrap qualifier hnb659fds: deploy, file-publishing, image-publishing
        // and lookup roles for this account and region.
        resources: [
          `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*-role-${this.account}-${this.region}`,
        ],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', {
      value: this.role.roleArn,
      description: 'Set as the AWS_DEPLOY_ROLE_ARN repository variable in GitHub',
    });
  }
}
