import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { Duration, RemovalPolicy, Size, Stack } from 'aws-cdk-lib';
import { CfnNamedQuery, CfnWorkGroup } from 'aws-cdk-lib/aws-athena';
import { CfnDatabase, CfnTable } from 'aws-cdk-lib/aws-glue';
import {
  DeliveryStream,
  EnableLogging,
  InputFormat,
  OutputFormat,
  S3Bucket,
  SchemaConfiguration,
  StreamEncryption,
} from 'aws-cdk-lib/aws-kinesisfirehose';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption, type IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/** Glue columns; must match services/processor/src/archive.ts ArchiveRecord (a test checks). */
export const ARCHIVE_COLUMNS = [
  { name: 'event_id', type: 'string' },
  { name: 'event_type', type: 'string' },
  { name: 'schema_version', type: 'int' },
  { name: 'player_id', type: 'string' },
  { name: 'occurred_at', type: 'string' },
  { name: 'event_date', type: 'string' },
  { name: 'received_at', type: 'string' },
  { name: 'payload', type: 'string' },
] as const;

export const DATABASE_NAME = 'eventstream';
export const TABLE_NAME = 'events';
const SQL_DIR = join(__dirname, '..', '..', 'sql');

/**
 * Long-term, queryable history: processor → Firehose (buffers, converts JSON to Parquet)
 * → S3, partitioned by day → Glue table → Athena SQL. Nothing here runs or costs money
 * while idle; Firehose, S3 and Athena all bill per use.
 */
export class Archive extends Construct {
  readonly bucket: Bucket;
  readonly deliveryStream: DeliveryStream;
  readonly workGroup: CfnWorkGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const { account } = Stack.of(this);

    this.bucket = new Bucket(this, 'Bucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.DESTROY,
      // Deploys a small custom resource that empties the bucket so `cdk destroy` succeeds.
      autoDeleteObjects: true,
      lifecycleRules: [
        { prefix: 'athena-results/', expiration: Duration.days(7) },
        { prefix: 'errors/', expiration: Duration.days(30) },
      ],
    });

    const database = new CfnDatabase(this, 'Database', {
      catalogId: account,
      databaseInput: { name: DATABASE_NAME, description: 'eventstream archive' },
    });

    const location = `s3://${this.bucket.bucketName}/events/`;
    const table = new CfnTable(this, 'EventsTable', {
      catalogId: account,
      databaseName: DATABASE_NAME,
      tableInput: {
        name: TABLE_NAME,
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [{ name: 'dt', type: 'string' }],
        parameters: {
          classification: 'parquet',
          // Partition projection: Athena computes partition paths from these rules, so no
          // crawler or MSCK REPAIR is needed when Firehose writes a new day.
          'projection.enabled': 'true',
          'projection.dt.type': 'date',
          'projection.dt.format': 'yyyy-MM-dd',
          'projection.dt.range': '2026-01-01,NOW',
          'projection.dt.interval': '1',
          'projection.dt.interval.unit': 'DAYS',
          'storage.location.template': `${location}dt=\${dt}/`,
        },
        storageDescriptor: {
          location,
          columns: ARCHIVE_COLUMNS.map((c) => ({ name: c.name, type: c.type })),
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
          },
        },
      },
    });
    table.addResourceDependency(database);

    // Firehose would otherwise create its own error log group with two-year retention.
    const firehoseLogs = new LogGroup(this, 'DeliveryStreamLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.deliveryStream = new DeliveryStream(this, 'DeliveryStream', {
      encryption: StreamEncryption.awsOwnedKey(),
      // CDK's own Bucket and IBucket typings disagree under exactOptionalPropertyTypes; the
      // cast is a typing workaround only, since Bucket implements IBucket.
      destination: new S3Bucket(this.bucket as IBucket, {
        // Partitioned by arrival date (UTC). Rows also carry event_date from occurred_at.
        loggingConfig: new EnableLogging(firehoseLogs),
        dataOutputPrefix: 'events/dt=!{timestamp:yyyy-MM-dd}/',
        errorOutputPrefix: 'errors/!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd}/',
        // Parquet conversion requires at least 64 MiB buffering; the interval caps latency.
        bufferingSize: Size.mebibytes(64),
        bufferingInterval: Duration.minutes(5),
        // No `compression` here: Parquet compresses its own column chunks (Snappy by default),
        // and CDK rejects destination compression when format conversion is on.
        dataFormatConversion: {
          schemaConfiguration: SchemaConfiguration.fromCfnTable(table),
          inputFormat: InputFormat.OPENX_JSON,
          outputFormat: OutputFormat.PARQUET,
        },
      }),
    });

    this.workGroup = new CfnWorkGroup(this, 'WorkGroup', {
      name: 'eventstream',
      description: 'Queries over the eventstream archive',
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        // Athena bills $5/TB scanned; this stops a runaway query at 1 GB (~$0.005).
        bytesScannedCutoffPerQuery: 1024 ** 3,
        engineVersion: { selectedEngineVersion: 'Athena engine version 3' },
        resultConfiguration: {
          outputLocation: `s3://${this.bucket.bucketName}/athena-results/`,
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
      },
    });
    this.workGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);

    for (const file of readdirSync(SQL_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      const sql = readFileSync(join(SQL_DIR, file), 'utf8');
      const name = basename(file, '.sql');
      const query = new CfnNamedQuery(this, `Query-${name}`, {
        name,
        database: DATABASE_NAME,
        workGroup: this.workGroup.ref,
        description: sql.split('\n')[0]?.replace(/^--\s*/, '') ?? name,
        queryString: sql,
      });
      query.addResourceDependency(this.workGroup);
    }
  }
}
