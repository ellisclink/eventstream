import { EVENT_TYPES, envelopeSchema, eventSchema, parseEvent } from '@eventstream/schema';

import { sampleEventJson } from '../../fixtures/events';

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return sampleEventJson('match_start', overrides);
}

function without(key: string): Record<string, unknown> {
  const event = validEvent();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- building invalid fixtures on purpose
  delete event[key];
  return event;
}

describe('event envelope schema', () => {
  it('accepts a valid event', () => {
    const result = eventSchema.safeParse(validEvent());
    expect(result.success).toBe(true);
  });

  it('rejects an event with no event_id', () => {
    const result = eventSchema.safeParse(without('event_id'));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('event_id');
  });

  it.each(EVENT_TYPES)('accepts event_type %s', (eventType) => {
    expect(eventSchema.safeParse(sampleEventJson(eventType)).success).toBe(true);
  });

  it.each([
    ['event_id is not a uuid', { event_id: 'abc' }],
    ['event_type is unknown', { event_type: 'teleport' }],
    ['schema_version is not an integer', { schema_version: 1.5 }],
    ['schema_version is zero', { schema_version: 0 }],
    ['player_id is blank', { player_id: '   ' }],
    ['occurred_at is not ISO-8601', { occurred_at: '12/10/2026' }],
    ['occurred_at has no timezone', { occurred_at: '2026-10-12T18:30:00' }],
    ['payload is an array', { payload: [] }],
    ['payload is a string', { payload: 'hello' }],
  ])('rejects an event when %s', (_label, overrides) => {
    expect(eventSchema.safeParse(validEvent(overrides)).success).toBe(false);
  });

  it.each(['event_type', 'schema_version', 'player_id', 'occurred_at', 'payload'])(
    'rejects an event missing %s',
    (key) => {
      expect(eventSchema.safeParse(without(key)).success).toBe(false);
    },
  );

  it('accepts timestamps with a numeric offset', () => {
    const event = validEvent({ occurred_at: '2026-10-12T20:30:00+02:00' });
    expect(eventSchema.safeParse(event).success).toBe(true);
  });

  it('generic envelope schema agrees with the full schema on shared fields', () => {
    expect(envelopeSchema.safeParse(validEvent()).success).toBe(true);
    expect(envelopeSchema.safeParse(without('event_id')).success).toBe(false);
  });
});

describe('parseEvent', () => {
  it('returns the typed event on success', () => {
    const input = sampleEventJson('purchase');
    expect(parseEvent(input)).toEqual({ ok: true, event: input });
  });

  it('returns readable issues without throwing on failure', () => {
    const result = parseEvent(without('event_id'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.startsWith('event_id:'))).toBe(true);
    }
  });

  it('handles non-object input', () => {
    expect(parseEvent(null).ok).toBe(false);
    expect(parseEvent('not json').ok).toBe(false);
  });
});
