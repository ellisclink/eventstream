#!/usr/bin/env node
import { App } from 'aws-cdk-lib';

import { buildApp } from '../lib/app.js';
import { readConfig } from '../lib/config.js';

const app = new App();
const config = readConfig(app.node);

if (config.budgetEmail === undefined) {
  // stderr, so `cdk synth` output on stdout stays valid YAML.
  console.warn(
    'BudgetStack skipped: pass -c budgetEmail=you@example.com to synthesize or deploy it.',
  );
}

buildApp(app, config);
