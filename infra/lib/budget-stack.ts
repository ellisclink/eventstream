import { Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import type { Construct } from 'constructs';

import { PROJECT_TAG } from './tags.js';

export interface BudgetStackProps extends StackProps {
  /** Address that receives the alert emails. Comes from CDK context, never from code. */
  readonly budgetEmail: string;
  /** Monthly cost limit in USD. */
  readonly monthlyLimitUsd: number;
}

/**
 * A monthly AWS cost budget with email alerts. Kept in its own stack so it can be deployed
 * first, before anything that costs money, and left in place while the pipeline stack is
 * destroyed and redeployed.
 */
export class BudgetStack extends Stack {
  constructor(scope: Construct, id: string, props: BudgetStackProps) {
    super(scope, id, props);

    const subscribers = [{ subscriptionType: 'EMAIL', address: props.budgetEmail }];

    new CfnBudget(this, 'MonthlyCostBudget', {
      budget: {
        budgetName: 'eventstream-monthly-cost',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyLimitUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          // Early warning on money already spent.
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
        {
          // AWS projects month-end spend; this fires before the limit is actually hit.
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
      ],
      // CfnBudget is not taggable through Tags.of(), so the project tag is set explicitly.
      resourceTags: [{ key: PROJECT_TAG.key, value: PROJECT_TAG.value }],
    });
  }
}
