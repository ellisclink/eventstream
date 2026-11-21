import { join } from 'node:path';

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

const REPO_ROOT = join(__dirname, '..', '..', '..');

export interface ServiceFunctionProps {
  /** Folder under services/, e.g. "ingest". The entry is services/<service>/src/handler.ts. */
  readonly service: string;
  readonly environment?: Record<string, string>;
  readonly timeout?: Duration;
  readonly memorySize?: number;
}

/**
 * Project defaults for every Lambda in one place: Node 22 on ARM (about 20% cheaper than
 * x86), X-Ray tracing, one-week log retention, and an esbuild bundle that resolves the
 * @eventstream/schema alias through the root tsconfig.
 */
export class ServiceFunction extends Construct {
  readonly function: NodejsFunction;

  constructor(scope: Construct, id: string, props: ServiceFunctionProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, 'Logs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.function = new NodejsFunction(this, 'Function', {
      entry: join(REPO_ROOT, 'services', props.service, 'src', 'handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout ?? Duration.seconds(10),
      tracing: Tracing.ACTIVE,
      logGroup,
      projectRoot: REPO_ROOT,
      depsLockFilePath: join(REPO_ROOT, 'package-lock.json'),
      environment: {
        POWERTOOLS_SERVICE_NAME: props.service,
        POWERTOOLS_LOG_LEVEL: 'INFO',
        NODE_OPTIONS: '--enable-source-maps',
        ...props.environment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        tsconfig: join(REPO_ROOT, 'tsconfig.json'),
        // The Node 22 runtime ships AWS SDK v3; bundling it would only add cold-start weight.
        externalModules: ['@aws-sdk/*'],
      },
    });
  }
}
