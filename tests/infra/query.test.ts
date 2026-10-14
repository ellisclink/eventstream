import { Match } from 'aws-cdk-lib/assertions';

import { eventstreamTemplate } from './helpers';

describe('query API (Milestone 4)', () => {
  it('adds GET methods for the stats routes, all behind the API key', () => {
    const template = eventstreamTemplate();
    for (const path of ['players', '{playerId}', 'daily', '{date}']) {
      template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: path });
    }
    const methods = template.findResources('AWS::ApiGateway::Method', {
      Properties: { HttpMethod: 'GET' },
    });
    expect(Object.keys(methods)).toHaveLength(3);
    for (const method of Object.values(methods) as { Properties: { ApiKeyRequired: boolean } }[]) {
      expect(method.Properties.ApiKeyRequired).toBe(true);
    }
  });

  it('gives the query Lambda point reads only', () => {
    const policies = eventstreamTemplate().findResources('AWS::IAM::Policy');
    const policy = Object.entries(policies).find(([id]) => id.startsWith('Query'))?.[1] as
      | { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } }
      | undefined;
    const actions = (policy?.Properties.PolicyDocument.Statement ?? []).flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    expect(actions.filter((a) => a.startsWith('dynamodb:')).sort()).toEqual([
      'dynamodb:BatchGetItem',
      'dynamodb:GetItem',
    ]);
  });

  it('configures the query Lambda with the table name', () => {
    eventstreamTemplate().hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          POWERTOOLS_SERVICE_NAME: 'query',
          TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });
});
