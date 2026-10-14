import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Match } from 'aws-cdk-lib/assertions';

import { ARCHIVE_COLUMNS } from '../../infra/lib/constructs/archive';
import { eventstreamTemplate } from './helpers';

describe('archive (Milestone 5)', () => {
  it('blocks public access and encrypts the bucket', () => {
    eventstreamTemplate().hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });
  });

  it('denies non-TLS access to the bucket', () => {
    eventstreamTemplate().hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('empties and deletes the bucket on destroy', () => {
    const template = eventstreamTemplate();
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('converts to Parquet via the Glue table and partitions by day', () => {
    eventstreamTemplate().hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      DeliveryStreamEncryptionConfigurationInput: { KeyType: 'AWS_OWNED_CMK' },
      ExtendedS3DestinationConfiguration: Match.objectLike({
        Prefix: 'events/dt=!{timestamp:yyyy-MM-dd}/',
        BufferingHints: { IntervalInSeconds: 300, SizeInMBs: 64 },
        DataFormatConversionConfiguration: Match.objectLike({
          Enabled: true,
          OutputFormatConfiguration: { Serializer: { ParquetSerDe: Match.anyValue() } },
          SchemaConfiguration: Match.objectLike({
            DatabaseName: 'eventstream',
            // A Ref to the Glue table, so the stream is created after the table exists.
            TableName: { Ref: Match.stringLikeRegexp('EventsTable') },
          }),
        }),
      }),
    });
  });

  it('defines the Glue table with partition projection and the archive columns', () => {
    eventstreamTemplate().hasResourceProperties('AWS::Glue::Table', {
      TableInput: Match.objectLike({
        Name: 'events',
        PartitionKeys: [{ Name: 'dt', Type: 'string' }],
        Parameters: Match.objectLike({
          'projection.enabled': 'true',
          'projection.dt.type': 'date',
        }),
        StorageDescriptor: Match.objectLike({
          Columns: ARCHIVE_COLUMNS.map((c) => ({ Name: c.name, Type: c.type })),
        }),
      }),
    });
  });

  it('caps Athena scans per query and stores results encrypted', () => {
    eventstreamTemplate().hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: 'eventstream',
      WorkGroupConfiguration: Match.objectLike({
        EnforceWorkGroupConfiguration: true,
        BytesScannedCutoffPerQuery: 1024 ** 3,
        ResultConfiguration: Match.objectLike({
          EncryptionConfiguration: { EncryptionOption: 'SSE_S3' },
        }),
      }),
    });
  });

  it('saves one named query per SQL file', () => {
    const files = readdirSync(join(__dirname, '..', '..', 'infra', 'sql')).filter((f) =>
      f.endsWith('.sql'),
    );
    expect(files.length).toBeGreaterThanOrEqual(5);
    eventstreamTemplate().resourceCountIs('AWS::Athena::NamedQuery', files.length);
  });

  it('lets the processor put records to Firehose and passes the stream name', () => {
    const template = eventstreamTemplate();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyName: Match.stringLikeRegexp('^Processor'),
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: ['firehose:PutRecord', 'firehose:PutRecordBatch'] }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          POWERTOOLS_SERVICE_NAME: 'processor',
          DELIVERY_STREAM_NAME: Match.anyValue(),
        }),
      },
    });
  });
});
