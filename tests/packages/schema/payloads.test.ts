import { eventSchema, ingestRequestSchema, MAX_EVENTS_PER_REQUEST } from '@eventstream/schema';

import { samplePayloads, sampleEventJson } from '../../fixtures/events';

describe('payload schemas', () => {
  it('rejects a payload that belongs to a different event type', () => {
    const event = sampleEventJson('purchase', { payload: samplePayloads.match_end });
    expect(eventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects unknown payload keys', () => {
    const event = sampleEventJson('level_up', { payload: { new_level: 3, cheat: true } });
    expect(eventSchema.safeParse(event).success).toBe(false);
  });

  it.each([
    ['negative price', 'purchase', { ...samplePayloads.purchase, price_cents: -1 }],
    ['fractional price', 'purchase', { ...samplePayloads.purchase, price_cents: 4.99 }],
    ['lowercase currency', 'purchase', { ...samplePayloads.purchase, currency: 'usd' }],
    ['unknown match result', 'match_end', { ...samplePayloads.match_end, result: 'abandoned' }],
    ['level zero', 'level_up', { new_level: 0 }],
    [
      'session longer than a day',
      'session_end',
      { ...samplePayloads.session_end, duration_s: 90_000 },
    ],
    ['non-uuid session id', 'session_start', { ...samplePayloads.session_start, session_id: 's1' }],
    ['unknown platform', 'session_start', { ...samplePayloads.session_start, platform: 'fridge' }],
  ] as const)('rejects %s', (_label, type, payload) => {
    expect(eventSchema.safeParse(sampleEventJson(type, { payload })).success).toBe(false);
  });
});

describe('ingest request schema', () => {
  it('requires at least one event', () => {
    expect(ingestRequestSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it(`caps a request at ${String(MAX_EVENTS_PER_REQUEST)} events`, () => {
    const events = Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, () => ({}));
    expect(ingestRequestSchema.safeParse({ events }).success).toBe(false);
  });
});
