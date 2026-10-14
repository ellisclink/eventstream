import { exportLines, findStackInfo } from '../../tools/stack-info/src/outputs';

// Output keys as CDK actually generates them for EventstreamStack (construct path + hash).
const outputs = [
  { OutputKey: 'IngestApiRestApiEndpoint4DEFB5CC', OutputValue: 'https://ignored/dev/' },
  { OutputKey: 'IngestApiUrlF2D81078', OutputValue: 'https://ingest.example/dev/' },
  { OutputKey: 'IngestApiKeyId7452CAC3', OutputValue: 'k-ingest' },
  { OutputKey: 'StatsApiUrl1A2B3C4D', OutputValue: 'https://stats.example/dev/' },
  { OutputKey: 'StatsApiKeyId5E6F7A8B', OutputValue: 'k-stats' },
];

describe('stack-info', () => {
  it('finds both APIs by their CDK output prefixes', () => {
    expect(findStackInfo(outputs)).toEqual({
      ingestUrl: 'https://ingest.example/dev/',
      ingestKeyId: 'k-ingest',
      statsUrl: 'https://stats.example/dev/',
      statsKeyId: 'k-stats',
    });
  });

  it('explains a missing output', () => {
    expect(() => findStackInfo([])).toThrow(/not found/);
  });

  it('prints shell-safe export lines for all four variables', () => {
    const info = findStackInfo(outputs);
    const bash = exportLines(info, { ingest: "a'b", stats: 's' }, 'bash');
    expect(bash).toHaveLength(4);
    expect(bash[1]).toBe(`export EVENTSTREAM_API_KEY='a'\\''b'`);
    expect(exportLines(info, { ingest: "a'b", stats: 's' }, 'powershell')[1]).toBe(
      `$env:EVENTSTREAM_API_KEY = 'a''b'`,
    );
  });
});
