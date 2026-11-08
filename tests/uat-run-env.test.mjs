// The environment of the Postbox a UAT run starts (tools/uat/run-env.mjs): a `- seed: git-remote` run carries its
// guard, so no git or gh in it reaches anything real (#305). The integrator’s read of #1001 found nothing tested that
// the guard reaches Postbox at all.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runEnv } from '../tools/uat/run-env.mjs';

const paths = { streams: '/r/streams', kiroStreams: '/r/streams/kiro', agyStreams: '/r/streams/agy', codexStreams: '/r/streams/codex' };
const env = (seed) => runEnv({ gate: { env: {} }, paths, scenario: { seed, gh: 'yes', skills: 'on' }, dir: '/r', opt: { telemetry: 'no' }, faults: null });

test('a git-remote run’s Postbox gets the guard, the fake gh first, the agent’s env file and no ssh agent', () => {
  const e = env('git-remote');
  assert.equal(e.GIT_ALLOW_PROTOCOL, 'file');
  assert.equal(e.GIT_CONFIG_KEY_0, 'protocol.allow');
  assert.equal(e.GIT_CONFIG_VALUE_0, 'never');
  assert.ok(e.PATH.startsWith('/r/bin:'), e.PATH);
  assert.equal(e.GH_CONFIG_DIR, '/r/gh-config');
  assert.equal(e.CLAUDE_ENV_FILE, '/r/agent-env.sh');
  assert.equal(e.SSH_AUTH_SOCK, '');
});

test('any other run’s Postbox gets none of it', () => {
  const e = env(null);
  for (const k of ['GIT_ALLOW_PROTOCOL', 'GIT_CONFIG_COUNT', 'GH_CONFIG_DIR', 'CLAUDE_ENV_FILE', 'SSH_AUTH_SOCK']) assert.equal(e[k], undefined, k);
});
