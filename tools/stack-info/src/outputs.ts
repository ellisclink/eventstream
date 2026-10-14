export interface StackInfo {
  /** Ingest API (POST /events): used by producers and the load generator. */
  readonly ingestUrl: string;
  readonly ingestKeyId: string;
  /** Stats API (GET /stats/*): read-only, separate key. */
  readonly statsUrl: string;
  readonly statsKeyId: string;
}

/**
 * CDK prefixes output keys with the construct path and a hash (e.g. "IngestApiUrlF2D81078"),
 * so outputs are found by prefix rather than exact name.
 */
export function findStackInfo(
  outputs: readonly { OutputKey?: string | undefined; OutputValue?: string | undefined }[],
): StackInfo {
  const find = (prefix: string) => {
    const value = outputs.find((o) => o.OutputKey?.startsWith(prefix))?.OutputValue;
    if (value === undefined) {
      throw new Error(`Stack output ${prefix}* not found. Is EventstreamStack deployed?`);
    }
    return value;
  };
  return {
    ingestUrl: find('IngestApiUrl'),
    ingestKeyId: find('IngestApiKeyId'),
    statsUrl: find('StatsApiUrl'),
    statsKeyId: find('StatsApiKeyId'),
  };
}

export type Shell = 'bash' | 'powershell';

/** Lines that set the environment variables the load generator and docs/demo.md use. */
export function exportLines(
  info: StackInfo,
  keys: { ingest: string; stats: string },
  shell: Shell,
): string[] {
  const vars = {
    EVENTSTREAM_API_URL: info.ingestUrl,
    EVENTSTREAM_API_KEY: keys.ingest,
    EVENTSTREAM_STATS_URL: info.statsUrl,
    EVENTSTREAM_STATS_KEY: keys.stats,
  };
  return Object.entries(vars).map(([name, value]) =>
    shell === 'powershell'
      ? `$env:${name} = '${value.replace(/'/g, "''")}'`
      : `export ${name}='${value.replace(/'/g, `'\\''`)}'`,
  );
}
