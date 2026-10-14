import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import {
  ApiKeySourceType,
  EndpointType,
  LambdaIntegration,
  MethodLoggingLevel,
  Period,
  RestApi,
  type IResource,
} from 'aws-cdk-lib/aws-apigateway';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface ApiLimits {
  /** Steady-state requests per second allowed for the API's key. */
  readonly rateLimit: number;
  readonly burstLimit: number;
  /** Requests per day: the hard ceiling on what a leaked key can cost. */
  readonly dailyQuota: number;
}

export interface ApiProps {
  readonly restApiName: string;
  readonly description: string;
  /** Who the generated key is for; becomes the key's description. */
  readonly keyDescription: string;
  readonly limits: ApiLimits;
}

/**
 * A REST API whose every method requires an API key, with a usage plan that throttles and
 * caps that key. The pipeline uses two of these so that a key embedded in game clients
 * (effectively public) can send events but can never read stats.
 */
export class Api extends Construct {
  readonly restApi: RestApi;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { limits } = props;

    this.restApi = new RestApi(this, 'RestApi', {
      restApiName: props.restApiName,
      description: props.description,
      endpointTypes: [EndpointType.REGIONAL],
      apiKeySourceType: ApiKeySourceType.HEADER,
      cloudWatchRole: false,
      deployOptions: {
        stageName: 'dev',
        metricsEnabled: true,
        // Execution logging would need an account-wide CloudWatch role and could log
        // bodies; metrics are enough here and dataTrace stays off.
        loggingLevel: MethodLoggingLevel.OFF,
        dataTraceEnabled: false,
        tracingEnabled: true,
        // Stage-wide ceiling; each API has exactly one key, so it matches the key's limits.
        throttlingRateLimit: limits.rateLimit,
        throttlingBurstLimit: limits.burstLimit,
      },
    });
    this.restApi.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const plan = this.restApi.addUsagePlan('UsagePlan', {
      name: `${props.restApiName}-plan`,
      throttle: { rateLimit: limits.rateLimit, burstLimit: limits.burstLimit },
      quota: { limit: limits.dailyQuota, period: Period.DAY },
    });
    plan.addApiStage({ stage: this.restApi.deploymentStage });

    // CDK generates the key value; it never appears in code, templates or outputs.
    const key = this.restApi.addApiKey('Key', { description: props.keyDescription });
    plan.addApiKey(key);

    new CfnOutput(this, 'Url', { value: this.restApi.url });
    new CfnOutput(this, 'KeyId', {
      value: key.keyId,
      description: 'aws apigateway get-api-key --api-key <id> --include-value',
    });
  }

  /** Adds a Lambda-backed method that requires an API key. */
  addRoute(resource: IResource, method: string, fn: IFunction): void {
    resource.addMethod(method, new LambdaIntegration(fn), { apiKeyRequired: true });
  }
}
