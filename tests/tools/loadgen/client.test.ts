import { postBatch, type FetchLike } from '../../../tools/loadgen/src/client';

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

function fakeFetch(...responses: (Response | Error)[]): jest.Mock & FetchLike {
  const queue = [...responses];
  return jest.fn(() => {
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected extra request');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
}

const noSleep = () => Promise.resolve();
const events = ['a', 'b', 'c'];

function sentBodies(mock: jest.Mock): unknown[] {
  return mock.mock.calls.map(
    ([, init]) => (JSON.parse((init as RequestInit).body as string) as { events: unknown }).events,
  );
}

describe('postBatch', () => {
  it('sends the API key header and counts a clean 202', async () => {
    const fetch = fakeFetch(response(202, { accepted: 3, rejected: [], failed: [] }));
    const result = await postBatch(events, {
      endpoint: 'https://api/events',
      apiKey: 'k',
      fetch,
      sleep: noSleep,
    });

    expect(result).toMatchObject({ status: 202, accepted: 3, rejected: 0, failed: 0, attempts: 1 });
    const init = (fetch.mock.calls as [string, RequestInit][])[0]?.[1];
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('k');
  });

  it('resends only the failed indexes', async () => {
    const fetch = fakeFetch(
      response(202, { accepted: 2, rejected: [], failed: [1] }),
      response(202, { accepted: 1, rejected: [], failed: [] }),
    );
    const result = await postBatch(events, { endpoint: 'e', apiKey: 'k', fetch, sleep: noSleep });

    expect(result).toMatchObject({ accepted: 3, failed: 0, attempts: 2 });
    expect(sentBodies(fetch)[1]).toEqual(['b']);
  });

  it('backs off and retries on 429 and network errors', async () => {
    const sleep = jest.fn(noSleep);
    const fetch = fakeFetch(
      response(429),
      new Error('ECONNRESET'),
      response(202, { accepted: 3, rejected: [], failed: [] }),
    );
    const result = await postBatch(events, { endpoint: 'e', apiKey: 'k', fetch, sleep });

    expect(result).toMatchObject({ status: 202, accepted: 3, attempts: 3 });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts and reports everything as failed', async () => {
    const fetch = fakeFetch(response(503), response(503));
    const result = await postBatch(events, {
      endpoint: 'e',
      apiKey: 'k',
      fetch,
      sleep: noSleep,
      maxAttempts: 2,
    });
    expect(result).toMatchObject({ status: 503, accepted: 0, failed: 3, attempts: 2 });
  });

  it('does not retry a 403', async () => {
    const fetch = fakeFetch(response(403, { message: 'Forbidden' }));
    const result = await postBatch(events, { endpoint: 'e', apiKey: 'bad', fetch, sleep: noSleep });
    expect(result).toMatchObject({ status: 403, failed: 3, attempts: 1 });
  });

  it('counts rejections from a 400', async () => {
    const fetch = fakeFetch(
      response(400, { accepted: 0, rejected: [{ index: 0, issues: [] }], failed: [] }),
    );
    const result = await postBatch(['x'], { endpoint: 'e', apiKey: 'k', fetch, sleep: noSleep });
    expect(result).toMatchObject({ status: 400, rejected: 1, failed: 0 });
  });
});
