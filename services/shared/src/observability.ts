import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

export const METRICS_NAMESPACE = 'Eventstream';

export interface Observability {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
}

/**
 * One logger, metrics buffer and tracer per Lambda, created at module load so warm
 * invocations reuse them. Logs are structured JSON, metrics are written as CloudWatch
 * Embedded Metric Format (no PutMetricData calls), and the tracer records X-Ray segments.
 */
export function createObservability(serviceName: string): Observability {
  return {
    logger: new Logger({ serviceName }),
    metrics: new Metrics({ namespace: METRICS_NAMESPACE, serviceName }),
    tracer: new Tracer({ serviceName }),
  };
}
