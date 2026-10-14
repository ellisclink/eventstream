import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * Single-table design: player aggregates, daily aggregates and dedupe markers share one
 * table, told apart by key prefixes (see packages/schema/src/stats.ts). On-demand billing
 * means no capacity to manage and zero cost when idle.
 */
export class StatsTable extends Construct {
  readonly table: TableV2;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new TableV2(this, 'Table', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      // Dedupe markers carry expires_at; DynamoDB deletes them for free after it passes.
      timeToLiveAttribute: 'expires_at',
      removalPolicy: RemovalPolicy.DESTROY,
      // Aggregates can be rebuilt from the S3 archive, so point-in-time recovery's cost
      // isn't justified for a dev table.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    });
  }
}
