import { MAX_EVENT_BYTES } from '@eventstream/schema';

import { validateRequest } from '../../../services/ingest/src/validate-request';
import { sampleEventJson } from '../../fixtures/events';

const body = (value: unknown) => JSON.stringify(value);

describe('validateRequest', () => {
  it.each([
    ['null body', null],
    ['empty body', '  '],
    ['invalid JSON', '{"events": ['],
    ['missing events', body({ items: [] })],
    ['empty events', body({ events: [] })],
    ['too many events', body({ events: Array.from({ length: 101 }, () => ({})) })],
    ['events not an array', body({ events: 'x' })],
  ])('treats %s as malformed', (_label, input) => {
    expect(validateRequest(input).kind).toBe('malformed');
  });

  it('separates valid events from rejected ones by index', () => {
    const good = sampleEventJson('purchase');
    const outcome = validateRequest(body({ events: [good, { nope: true }, good] }));

    expect(outcome.kind).toBe('checked');
    if (outcome.kind !== 'checked') return;
    expect(outcome.valid.map((v) => v.index)).toEqual([0, 2]);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]?.index).toBe(1);
    expect(outcome.rejected[0]?.issues.length).toBeGreaterThan(0);
  });

  it('rejects an oversized event without parsing it', () => {
    const huge = sampleEventJson('match_start', { player_id: 'x'.repeat(MAX_EVENT_BYTES) });
    const outcome = validateRequest(body({ events: [huge] }));

    expect(outcome.kind === 'checked' && outcome.rejected[0]?.issues[0]).toMatch(/exceeds/);
  });
});
