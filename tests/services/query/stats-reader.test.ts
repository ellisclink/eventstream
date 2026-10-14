import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';

import { handler } from '../../../services/query/src/handler';
import { dynamoStatsReader } from '../../../services/query/src/stats-reader';

const dbMock = mockClient(DynamoDBDocumentClient);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

beforeEach(() => dbMock.reset());

describe('dynamoStatsReader', () => {
  it('reads a player by its single-table key', async () => {
    dbMock.on(GetCommand).resolves({ Item: { events: 1 } });
    await expect(dynamoStatsReader(db, 't').getPlayer('p1')).resolves.toEqual({ events: 1 });
    expect(dbMock.commandCalls(GetCommand)[0]?.args[0].input.Key).toEqual({
      pk: 'PLAYER#p1',
      sk: 'STATS',
    });
  });

  it('retries unprocessed BatchGet keys', async () => {
    dbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: { t: [{ date: '2026-10-12', events: 1 }] },
        UnprocessedKeys: { t: { Keys: [{ pk: 'DAY#2026-10-13', sk: 'TOTALS' }] } },
      })
      .resolvesOnce({ Responses: { t: [{ date: '2026-10-13', events: 2 }] } });

    const days = await dynamoStatsReader(db, 't').getDays(['2026-10-12', '2026-10-13']);
    expect([...days.keys()]).toEqual(['2026-10-12', '2026-10-13']);
    expect(dbMock.commandCalls(BatchGetCommand)).toHaveLength(2);
  });

  it('fails rather than returning partial data when keys stay unprocessed', async () => {
    dbMock.on(BatchGetCommand).resolves({
      Responses: { t: [] },
      UnprocessedKeys: { t: { Keys: [{ pk: 'DAY#2026-10-13', sk: 'TOTALS' }] } },
    });
    await expect(dynamoStatsReader(db, 't').getDays(['2026-10-13'])).rejects.toThrow(/unprocessed/);
  });
});

describe('query handler', () => {
  const context = { functionName: 'query', awsRequestId: 'r' } as Context;

  it('serves a player from the configured table', async () => {
    dbMock.on(GetCommand).resolves({ Item: { events: 4 } });
    const result = await handler(
      {
        resource: '/stats/players/{playerId}',
        pathParameters: { playerId: 'p1' },
      } as unknown as APIGatewayProxyEvent,
      context,
    );
    expect(result.statusCode).toBe(200);
    expect(dbMock.commandCalls(GetCommand)[0]?.args[0].input.TableName).toBe('stats-test');
  });

  it('returns 500 without leaking the error when DynamoDB fails', async () => {
    dbMock.on(GetCommand).rejects(new Error('boom: internal detail'));
    const result = await handler(
      {
        resource: '/stats/players/{playerId}',
        pathParameters: { playerId: 'p1' },
      } as unknown as APIGatewayProxyEvent,
      context,
    );
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('internal detail');
  });
});
