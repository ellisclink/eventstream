import { parseArgs } from 'node:util';

export const USAGE = `Usage: npm run loadgen -- [options]

Sends simulated game events to POST /events.

Options:
  --url <url>            API base URL (CDK output ApiUrl). Env: EVENTSTREAM_API_URL
  --rate <n>             Events per second (default 50)
  --duration <s>         Seconds to run (default 30)
  --batch-size <n>       Events per request, 1-100 (default 25)
  --players <n>          Simulated players (default 50)
  --invalid-ratio <f>    Fraction of events deliberately invalid, 0-1 (default 0)
  --max-in-flight <n>    Concurrent requests (default 10)
  --seed <n>             Seed for reproducible runs (default: random)
  --dry-run              Print events as JSON lines instead of sending
  --count <n>            Events to print in --dry-run (default 10)
  -h, --help             Show this help

The API key is read only from the EVENTSTREAM_API_KEY environment variable, so it never
ends up in shell history or process listings.`;

export interface CliOptions {
  readonly url: string | undefined;
  readonly apiKey: string | undefined;
  readonly rate: number;
  readonly durationSeconds: number;
  readonly batchSize: number;
  readonly players: number;
  readonly invalidRatio: number;
  readonly maxInFlight: number;
  readonly seed: number;
  readonly dryRun: boolean;
  readonly count: number;
  readonly help: boolean;
}

function num(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`--${name} must be a number between ${String(min)} and ${String(max)}`);
  }
  return value;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      url: { type: 'string' },
      rate: { type: 'string' },
      duration: { type: 'string' },
      'batch-size': { type: 'string' },
      players: { type: 'string' },
      'invalid-ratio': { type: 'string' },
      'max-in-flight': { type: 'string' },
      seed: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      count: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  return {
    url: values.url ?? env['EVENTSTREAM_API_URL'],
    apiKey: env['EVENTSTREAM_API_KEY'],
    rate: num(values.rate, 50, 'rate', 0.1, 5000),
    durationSeconds: num(values.duration, 30, 'duration', 1, 3600),
    batchSize: Math.floor(num(values['batch-size'], 25, 'batch-size', 1, 100)),
    players: Math.floor(num(values.players, 50, 'players', 1, 100_000)),
    invalidRatio: num(values['invalid-ratio'], 0, 'invalid-ratio', 0, 1),
    maxInFlight: Math.floor(num(values['max-in-flight'], 10, 'max-in-flight', 1, 200)),
    seed: Math.floor(num(values.seed, Math.floor(Math.random() * 2 ** 31), 'seed', 0, 2 ** 32)),
    dryRun: values['dry-run'],
    count: Math.floor(num(values.count, 10, 'count', 1, 100_000)),
    help: values.help,
  };
}

/** Accepts the CDK ApiUrl output (".../dev/") or a URL that already ends in /events. */
export function eventsEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith('/events')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/events`;
  }
  return url.toString();
}
