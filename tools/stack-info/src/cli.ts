import { parseArgs } from 'node:util';

import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

import { exportLines, findStackInfo, type Shell } from './outputs.js';

const USAGE = `Usage: npm run stack-info -- [--export bash|powershell]

Prints both APIs' URLs and key ids. With --export, prints lines that set
EVENTSTREAM_API_URL/_KEY (ingest) and EVENTSTREAM_STATS_URL/_KEY (stats):

  bash:        eval "$(npm run -s stack-info -- --export bash)"
  PowerShell:  npm run -s stack-info -- --export powershell | Invoke-Expression

Uses your current AWS credentials (AWS_PROFILE).`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      export: { type: 'string' },
      stack: { type: 'string', default: 'EventstreamStack' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.export !== undefined && values.export !== 'bash' && values.export !== 'powershell') {
    console.error('--export must be bash or powershell');
    return 2;
  }

  const stacks = await new CloudFormationClient({}).send(
    new DescribeStacksCommand({ StackName: values.stack }),
  );
  const info = findStackInfo(stacks.Stacks?.[0]?.Outputs ?? []);

  if (values.export === undefined) {
    console.log(`Ingest URL:    ${info.ingestUrl}`);
    console.log(`Ingest key id: ${info.ingestKeyId}`);
    console.log(`Stats URL:     ${info.statsUrl}`);
    console.log(`Stats key id:  ${info.statsKeyId}`);
    console.log('Run with --export bash|powershell to set the environment variables.');
    return 0;
  }

  const apigw = new APIGatewayClient({});
  const keyValue = async (id: string) =>
    (await apigw.send(new GetApiKeyCommand({ apiKey: id, includeValue: true }))).value;
  const [ingest, stats] = await Promise.all([
    keyValue(info.ingestKeyId),
    keyValue(info.statsKeyId),
  ]);
  if (ingest === undefined || stats === undefined) {
    console.error('Could not read the API key values (check apigateway:GET permission).');
    return 1;
  }
  const shell: Shell = values.export;
  for (const line of exportLines(info, { ingest, stats }, shell)) {
    console.log(line);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  },
);
