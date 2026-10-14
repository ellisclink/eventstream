import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { PROJECT_TAG, buildApp } from '../../infra/lib/app';
import { readConfig } from '../../infra/lib/config';
import { cdkJsonContext } from './cdk-context';

const EMAIL = 'alerts@example.com';

function budgetTemplate(context: Record<string, unknown> = { budgetEmail: EMAIL }) {
  const app = new App({ context: cdkJsonContext(context) });
  const { budgetStack } = buildApp(app, readConfig(app.node, {}));
  if (budgetStack === undefined) {
    throw new Error('expected BudgetStack to be created');
  }
  return { app, budgetStack, template: Template.fromStack(budgetStack) };
}

describe('BudgetStack', () => {
  it('creates exactly one monthly 5 USD cost budget', () => {
    const { template } = budgetTemplate();

    template.resourceCountIs('AWS::Budgets::Budget', 1);
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: {
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 5, Unit: 'USD' },
      },
    });
  });

  it('emails the address from context for actual and forecasted spend', () => {
    const { template } = budgetTemplate();
    const subscriber = [{ SubscriptionType: 'EMAIL', Address: EMAIL }];

    template.hasResourceProperties('AWS::Budgets::Budget', {
      NotificationsWithSubscribers: Match.arrayEquals([
        {
          Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 80 }),
          Subscribers: subscriber,
        },
        {
          Notification: Match.objectLike({ NotificationType: 'FORECASTED', Threshold: 100 }),
          Subscribers: subscriber,
        },
      ]),
    });
  });

  it('does not hardcode an email address', () => {
    const { template } = budgetTemplate({ budgetEmail: 'someone-else@example.org' });
    const json = JSON.stringify(template.toJSON());

    expect(json).toContain('someone-else@example.org');
    expect(json).not.toContain(EMAIL);
  });

  it('accepts a budgetLimitUsd override from context', () => {
    const { template } = budgetTemplate({ budgetEmail: EMAIL, budgetLimitUsd: '10' });
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 10, Unit: 'USD' } }),
    });
  });

  it('carries the project=eventstream tag', () => {
    const { app, budgetStack } = budgetTemplate();
    app.synth();
    expect(budgetStack.tags.tagValues()).toEqual({ [PROJECT_TAG.key]: PROJECT_TAG.value });
  });

  it('tags the budget resource itself', () => {
    const { template } = budgetTemplate();
    template.hasResourceProperties('AWS::Budgets::Budget', {
      ResourceTags: [{ Key: PROJECT_TAG.key, Value: PROJECT_TAG.value }],
    });
  });
});
