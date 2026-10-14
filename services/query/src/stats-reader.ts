import { BatchGetCommand, GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { keys } from '@eventstream/schema';

type Item = Record<string, unknown>;

export interface StatsReader {
  getPlayer(playerId: string): Promise<Item | undefined>;
  getDay(date: string): Promise<Item | undefined>;
  getDays(dates: string[]): Promise<Map<string, Item>>;
}

/** BatchGetItem accepts at most 100 keys; the API caps ranges at 31 days, so one call fits. */
const MAX_UNPROCESSED_RETRIES = 3;

export function dynamoStatsReader(db: DynamoDBDocumentClient, tableName: string): StatsReader {
  const get = async (key: Record<string, string>) => {
    const result = await db.send(new GetCommand({ TableName: tableName, Key: key }));
    return result.Item;
  };

  return {
    getPlayer: (playerId) => get(keys.player(playerId)),
    getDay: (date) => get(keys.day(date)),

    async getDays(dates) {
      const found = new Map<string, Item>();
      let pending: Record<string, unknown>[] = dates.map((d) => keys.day(d));

      // BatchGet may return some keys as "unprocessed" under load; ask again for just those.
      for (let attempt = 0; pending.length > 0 && attempt <= MAX_UNPROCESSED_RETRIES; attempt++) {
        const result = await db.send(
          new BatchGetCommand({ RequestItems: { [tableName]: { Keys: pending } } }),
        );
        for (const item of result.Responses?.[tableName] ?? []) {
          if (typeof item['date'] === 'string') {
            found.set(item['date'], item);
          }
        }
        pending = result.UnprocessedKeys?.[tableName]?.Keys ?? [];
      }
      if (pending.length > 0) {
        throw new Error(`BatchGet left ${String(pending.length)} keys unprocessed`);
      }
      return found;
    },
  };
}
