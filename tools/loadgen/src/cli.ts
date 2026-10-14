import { USAGE, eventsEndpoint, parseCliArgs } from './args.js';
import { postBatch } from './client.js';
import { EventGenerator } from './generator.js';
import { Random } from './random.js';
import { run } from './runner.js';

async function main(): Promise<number> {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2), process.env);
  } catch (error) {
    console.error((error as Error).message);
    console.error(USAGE);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const rng = new Random(options.seed);
  const generator = new EventGenerator(rng, options.players);

  if (options.dryRun) {
    for (let i = 0; i < options.count; i++) {
      console.log(JSON.stringify(generator.next(new Date())));
    }
    return 0;
  }

  if (options.url === undefined || options.apiKey === undefined) {
    console.error(
      'Set --url (or EVENTSTREAM_API_URL) and the EVENTSTREAM_API_KEY environment variable.',
    );
    return 2;
  }

  const endpoint = eventsEndpoint(options.url);
  const apiKey = options.apiKey;
  console.error(
    `Sending ~${String(options.rate)} events/s for ${String(options.durationSeconds)}s to ${endpoint} (seed ${String(options.seed)})`,
  );

  const summary = await run(options, {
    generator,
    rng,
    post: (events) => postBatch(events, { endpoint, apiKey }),
    onProgress: (s) => {
      console.error(
        `  ${String(s.events)} events, p95 ${String(s.latencyMs.p95)} ms, statuses ${JSON.stringify(s.statusCounts)}`,
      );
    },
  });

  console.log(JSON.stringify(summary, null, 2));
  // A run where events were dropped should fail a script or CI step that runs it.
  return summary.failed > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
