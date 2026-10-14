import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'js-yaml';

interface Step {
  uses?: string;
  run?: string;
  name?: string;
  with?: Record<string, string>;
}
interface Job {
  uses?: string;
  needs?: string | string[];
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
}

function workflow(name: string): Workflow {
  return load(
    readFileSync(join(__dirname, '..', '..', '.github', 'workflows', name), 'utf8'),
  ) as Workflow;
}

const allRuns = (w: Workflow) =>
  Object.values(w.jobs)
    .flatMap((j) => j.steps ?? [])
    .map((s) => s.run ?? '')
    .join('\n');

describe('ci.yml', () => {
  const ci = workflow('ci.yml');

  it('runs on push, pull request, and when called by deploy', () => {
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'push', 'workflow_call']);
    expect(ci.on['push']).toEqual({ branches: ['main'] });
  });

  it('has read-only permissions and never deploys', () => {
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(allRuns(ci)).not.toMatch(/cdk deploy/);
    expect(JSON.stringify(ci)).not.toMatch(/id-token/);
  });

  it('runs every check on Node 22', () => {
    const steps = ci.jobs['check']?.steps ?? [];
    expect(
      steps.find((s) => s.uses?.startsWith('actions/setup-node'))?.with?.['node-version'],
    ).toBe(22);
    for (const command of [
      'npm ci',
      'npm run typecheck',
      'npm run lint',
      'npm run format:check',
      'npm test',
      'npx cdk synth',
    ]) {
      expect(allRuns(ci)).toContain(command);
    }
  });
});

describe('deploy.yml', () => {
  const deploy = workflow('deploy.yml');
  const job = deploy.jobs['deploy'];

  it('deploys only from main or a manual run', () => {
    expect(deploy.on).toEqual({ push: { branches: ['main'] }, workflow_dispatch: null });
  });

  it('runs the full CI checks first', () => {
    expect(deploy.jobs['checks']?.uses).toBe('./.github/workflows/ci.yml');
    expect(job?.needs).toBe('checks');
  });

  it('uses OIDC in the dev environment, not stored keys', () => {
    expect(job?.environment).toBe('dev');
    expect(job?.permissions?.['id-token']).toBe('write');
    const creds = job?.steps?.find((s) =>
      s.uses?.startsWith('aws-actions/configure-aws-credentials'),
    );
    expect(creds?.with?.['role-to-assume']).toBe('${{ vars.AWS_DEPLOY_ROLE_ARN }}');
    expect(JSON.stringify(deploy)).not.toMatch(
      /aws-access-key-id|aws-secret-access-key|AWS_SECRET/i,
    );
  });

  it('is inactive until the role variable is configured', () => {
    expect(job?.if).toContain("vars.AWS_DEPLOY_ROLE_ARN != ''");
  });

  it('never cancels a running deploy', () => {
    expect(deploy.concurrency).toEqual({ group: 'deploy-dev', 'cancel-in-progress': false });
  });

  it('deploys only the pipeline stack and smoke-tests that auth is enforced', () => {
    const runs = allRuns(deploy);
    expect(runs).toMatch(/cdk deploy EventstreamStack/);
    expect(runs).not.toMatch(/--all|BudgetStack|GithubOidcStack/);
    expect(runs).toContain('test "${status}" = "403"');
  });
});

describe('supply chain', () => {
  it('fails CI on high-severity advisories in runtime dependencies', () => {
    expect(allRuns(workflow('ci.yml'))).toContain('npm audit --omit=dev --audit-level=high');
  });

  it('has Dependabot watching npm and GitHub Actions', () => {
    const config = load(
      readFileSync(join(__dirname, '..', '..', '.github', 'dependabot.yml'), 'utf8'),
    ) as { updates: { 'package-ecosystem': string }[] };
    expect(config.updates.map((u) => u['package-ecosystem']).sort()).toEqual([
      'github-actions',
      'npm',
    ]);
  });

  it('smoke-tests that both APIs refuse requests without a key', () => {
    const runs = allRuns(workflow('deploy.yml'));
    expect(runs).toContain('output IngestApiUrl');
    expect(runs).toContain('output StatsApiUrl');
    expect(runs.match(/test "\$\{status\}" = "403"/g)).toHaveLength(2);
  });
});
