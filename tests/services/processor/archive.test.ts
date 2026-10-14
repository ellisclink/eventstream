import { FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';
import type { QueuedEvent } from '@eventstream/schema';
import { mockClient } from 'aws-sdk-client-mock';

import { ARCHIVE_COLUMNS } from '../../../infra/lib/constructs/archive';
import {
  FIREHOSE_MAX_BYTES,
  FIREHOSE_MAX_RECORDS,
  batchForFirehose,
  sendToArchive,
  toArchiveRecord,
} from '../../../services/processor/src/archive';
import { sampleEvent } from '../../fixtures/events';

const firehoseMock = mockClient(FirehoseClient);
const firehose = new FirehoseClient({});

function queued(n: number): QueuedEvent[] {
  return Array.from({ length: n }, () => ({
    received_at: '2026-10-13T10:00:00.000Z',
    event: sampleEvent('purchase', { occurred_at: '2026-10-12T23:30:00-02:00' }),
  }));
}

beforeEach(() => firehoseMock.reset());

describe('toArchiveRecord', () => {
  it('flattens the event with a UTC timestamp, UTC date and JSON payload', () => {
    const [q] = queued(1);
    if (!q) throw new Error('fixture');
    const record = toArchiveRecord(q);
    expect(record).toMatchObject({
      event_type: 'purchase',
      occurred_at: '2026-10-13T01:30:00.000Z',
      event_date: '2026-10-13',
      received_at: '2026-10-13T10:00:00.000Z',
    });
    expect(JSON.parse(record.payload)).toEqual(q.event.payload);
  });

  it('has exactly the columns of the Glue table, in a type Parquet conversion accepts', () => {
    const [q] = queued(1);
    if (!q) throw new Error('fixture');
    const record = toArchiveRecord(q);
    expect(Object.keys(record).sort()).toEqual(ARCHIVE_COLUMNS.map((c) => c.name).sort());
    for (const column of ARCHIVE_COLUMNS) {
      const value = record[column.name];
      expect(typeof value).toBe(column.type === 'int' ? 'number' : 'string');
    }
  });
});

describe('batchForFirehose', () => {
  it('splits at 500 records', () => {
    const lines = Array.from({ length: 1201 }, (_, i) => ({
      id: String(i),
      data: new Uint8Array(10),
    }));
    expect(batchForFirehose(lines).map((b) => b.length)).toEqual([FIREHOSE_MAX_RECORDS, 500, 201]);
  });

  it('splits before exceeding 4 MiB', () => {
    const big = { id: 'x', data: new Uint8Array(FIREHOSE_MAX_BYTES / 2 - 1) };
    expect(batchForFirehose([big, big, big]).map((b) => b.length)).toEqual([2, 1]);
  });
});

describe('sendToArchive', () => {
  it('sends newline-delimited JSON and reports nothing failed on success', async () => {
    firehoseMock
      .on(PutRecordBatchCommand)
      .resolves({ FailedPutCount: 0, RequestResponses: [{ RecordId: 'a' }] });
    const failed = await sendToArchive(firehose, 'stream', queued(1));

    expect(failed).toEqual([]);
    const input = firehoseMock.commandCalls(PutRecordBatchCommand)[0]?.args[0].input;
    expect(input?.DeliveryStreamName).toBe('stream');
    const text = new TextDecoder().decode(input?.Records?.[0]?.Data);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toHaveProperty('event_id');
  });

  it('reports the event ids of individually rejected records', async () => {
    const events = queued(3);
    firehoseMock.on(PutRecordBatchCommand).resolves({
      FailedPutCount: 1,
      RequestResponses: [
        { RecordId: 'a' },
        { ErrorCode: 'ServiceUnavailableException' },
        { RecordId: 'c' },
      ],
    });
    expect(await sendToArchive(firehose, 'stream', events)).toEqual([events[1]?.event.event_id]);
  });

  it('reports every event in a batch whose call failed', async () => {
    firehoseMock.on(PutRecordBatchCommand).rejects(new Error('throttled'));
    expect(await sendToArchive(firehose, 'stream', queued(4))).toHaveLength(4);
  });
});
