#!/usr/bin/env node
// The CDK app of a hosted Postbox’s test deployment (infra/README.md). What differs between deployments comes in as
// context (`-c name=value`), never from this file: the certificate, and who may sign in.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { PostboxStack } from './lib/postbox-stack.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = new App();
const context = (/** @type {string} */ name) => app.node.tryGetContext(name);
const list = (/** @type {unknown} */ value) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

/** The clone’s commit, for the build line in the sidebar; nothing when this isn’t a clone. */
function commit() {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return ''; // not a git checkout: the build line shows the version alone
  }
}

new PostboxStack(app, context('stackName') ?? 'PostboxTest', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  root,
  commit: commit(),
  certificateArn: context('certificateArn'),
  domainName: context('domainName'),
  allowSubjects: list(context('allowSubjects')),
  openTo: context('openTo') ?? '0.0.0.0/0',
});
