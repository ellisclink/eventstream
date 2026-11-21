// Keep Powertools quiet and local during tests: no EMF output, no X-Ray, no log noise.
process.env['POWERTOOLS_LOG_LEVEL'] = 'SILENT';
process.env['POWERTOOLS_METRICS_DISABLED'] = 'true';
process.env['POWERTOOLS_TRACE_ENABLED'] = 'false';
process.env['POWERTOOLS_METRICS_NAMESPACE'] = 'EventstreamTest';
process.env['AWS_REGION'] ??= 'us-east-1';

// Handlers read their wiring at module load; give them test values before any import runs.
process.env['QUEUE_URL'] = 'https://sqs.test/queue';
process.env['TABLE_NAME'] = 'stats-test';
process.env['DELIVERY_STREAM_NAME'] = 'archive-test';
