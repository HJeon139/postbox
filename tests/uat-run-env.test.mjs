// The environment of the Postbox a UAT run starts (tools/uat/run-env.mjs): a `- seed: git-remote` run carries its
// guard, so its git reaches no network remote and its gh is a fake (#305). The integrator’s read of #1001 found nothing tested that
// the guard reaches Postbox at all.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO_TOKEN } from '../tools/uat/git-remote.mjs';
import { runEnv } from '../tools/uat/run-env.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';

const paths = { streams: '/r/streams', kiroStreams: '/r/streams/kiro', agyStreams: '/r/streams/agy', codexStreams: '/r/streams/codex' };
const env = (seed, more = {}) =>
  runEnv({ gate: { env: {} }, paths, scenario: { seed, gh: 'yes', skills: 'on', ...more }, dir: '/r', opt: { telemetry: 'no' }, faults: null });

test('a git-remote run’s Postbox gets the guard, the fake gh first, the agent’s env file and no ssh agent', () => {
  const e = env('git-remote');
  assert.equal(e.GIT_ALLOW_PROTOCOL, 'file');
  assert.equal(e.GIT_CONFIG_KEY_0, 'protocol.allow');
  assert.equal(e.GIT_CONFIG_VALUE_0, 'never');
  assert.ok(e.PATH.startsWith('/r/bin:'), e.PATH);
  assert.equal(e.GH_CONFIG_DIR, '/r/gh-config');
  assert.equal(e.GH_TOKEN, NO_TOKEN, 'empty, gh would go to the keychain');
  assert.equal(e.CLAUDE_ENV_FILE, '/r/agent-env.sh');
  assert.equal(e.SSH_AUTH_SOCK, '');
  assert.equal(e.GIT_CONFIG_GLOBAL, '/r/gitconfig', 'the person’s own ~/.gitconfig: hooks, credential helpers, insteadOf');
  assert.equal(e.GIT_CONFIG_NOSYSTEM, '1', 'nor the system’s, as Homebrew’s');
});

test('any other run’s Postbox gets no gh login and no network git, so its agents can’t change the person’s GitHub', () => {
  const e = env(null);
  assert.equal(e.GIT_ALLOW_PROTOCOL, 'file');
  assert.equal(e.GIT_CONFIG_KEY_0, 'protocol.allow');
  assert.equal(e.GH_CONFIG_DIR, '/r/gh-config');
  // Set, not empty: gh reads an empty GH_TOKEN as none, and goes to the keychain.
  for (const k of ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN']) assert.equal(e[k], NO_TOKEN, k);
  for (const k of ['GITHUB_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) assert.equal(e[k], '', k);
});

test('any other run keeps its real gh on PATH, its ssh agent for hosts, and its own git identity', () => {
  const e = env(null);
  for (const k of ['PATH', 'CLAUDE_ENV_FILE', 'SSH_AUTH_SOCK', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) assert.equal(e[k], undefined, k);
});

test('a scenario that says `- github: real` gets none of the guard', () => {
  const e = env(null, { github: 'real' });
  for (const k of ['GIT_ALLOW_PROTOCOL', 'GIT_CONFIG_COUNT', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN']) assert.equal(e[k], undefined, k);
});

test('only `- github: real` hands a scenario the person’s GitHub, and a mistyped value doesn’t', () => {
  const github = (line) => parseScenario(`# A run\n\n${line}\n\nRead back.\n`).github;
  assert.equal(github('- github: real'), 'real');
  assert.equal(github('- github: yes'), 'none');
  assert.equal(github('- steps: 4'), 'none');
});
