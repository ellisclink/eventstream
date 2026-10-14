import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { GithubOidcStack } from '../../infra/lib/github-oidc-stack';
import { cdkJsonContext } from './cdk-context';
import { synthApp } from './helpers';

const REPO = 'octo-org/eventstream';

function template(existingProviderArn?: string): Template {
  const app = new App({ context: cdkJsonContext() });
  const stack = new GithubOidcStack(app, 'Oidc', {
    githubRepo: REPO,
    existingProviderArn,
    env: { account: '111111111111', region: 'eu-west-2' },
  });
  return Template.fromStack(stack);
}

describe('GithubOidcStack (Milestone 7)', () => {
  it('registers the GitHub OIDC provider for the STS audience', () => {
    template().hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
    });
  });

  it('trusts only the repo’s dev environment, with an exact subject match', () => {
    template().hasResourceProperties('AWS::IAM::Role', {
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': `repo:${REPO}:environment:dev`,
              },
            },
          }),
        ],
      },
    });
  });

  it('may only assume the CDK bootstrap roles', () => {
    template().hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Resource: 'arn:aws:iam::111111111111:role/cdk-hnb659fds-*-role-111111111111-eu-west-2',
          },
        ],
      },
    });
  });

  it('reuses an existing provider instead of creating a second one', () => {
    const t = template(
      'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com',
    );
    t.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    t.resourceCountIs('AWS::IAM::Role', 1);
  });

  it('is only part of the app when githubRepo context is given', () => {
    expect(synthApp().githubOidcStack).toBeUndefined();
    expect(synthApp({ githubRepo: REPO }).githubOidcStack).toBeDefined();
    expect(() => synthApp({ githubRepo: 'not a repo' })).toThrow(/githubRepo/);
  });
});
