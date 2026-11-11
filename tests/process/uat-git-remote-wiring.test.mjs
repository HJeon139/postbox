// `- seed: git-remote`’s wiring into the runner (#1031, from the reviews of #1001): the workspace is seeded, the
// preflight checks the environment itself rather than the workspace’s own config, and the remote is removed when the
// run stops, a stop before Postbox starts included. Real git, in temp folders (tests/AGENTS.md): HOME is a temp folder
// of its own and system config is off, so nothing here reads your config.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { remotePaths } from '../../tools/uat/git-remote.mjs';
import { preflightRun } from '../../tools/uat/github-guard.mjs';
import { runEnv } from '../../tools/uat/run-env.mjs';
import { runStop } from '../../tools/uat/stop.mjs';
import { makeWorkspace } from '../../tools/uat/workspace.mjs';

process.env.HOME = mkdtempSync(join(tmpdir(), 'postbox-uat-wiring-home-'));
process.env.GIT_CONFIG_NOSYSTEM = '1';
const home = process.env.HOME;
after(() => rmSync(home, { recursive: true, force: true }));
const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const scenario = { seed: 'git-remote', skills: 'on' };
/** A run folder and its workspace, made as the runner makes them, with the environment it gives Postbox. */
function run() {
  const dir = mkdtempSync(join(tmpdir(), 'postbox-uat-wiring-'));
  made.push(dir);
  const workspace = join(dir, 'workspace');
  makeWorkspace(scenario, { workspace }, dir);
  const paths = { streams: join(dir, 'streams'), kiroStreams: '', agyStreams: '', codexStreams: '' };
  const env = { ...process.env, ...runEnv({ gate: { env: {} }, paths, scenario, dir, faults: null }) };
  return { dir, workspace, env };
}

describe('the runner seeds the remote and checks it', () => {
  test('makeWorkspace seeds the remote, and the preflight passes on what it made', () => {
    const r = run();
    assert.ok(existsSync(remotePaths(r.dir).remote), 'the bare repository is there');
    assert.doesNotThrow(() => preflightRun(scenario, r.workspace, r.dir, r.env));
  });

  test('the preflight reads the environment’s guard, not only the workspace’s config', () => {
    const r = run();
    // The workspace’s own .git/config still refuses https, so a probe run inside it would pass without the environment.
    const { GIT_ALLOW_PROTOCOL: _a, GIT_CONFIG_COUNT: _b, ...open } = r.env;
    assert.throws(() => preflightRun(scenario, r.workspace, r.dir, open), /git in the run isn’t refused an https remote/);
  });

  test('a failed preflight removes the remote it was checking, so nothing of the run is left', () => {
    const r = run();
    const { GIT_ALLOW_PROTOCOL: _a, GIT_CONFIG_COUNT: _b, ...open } = r.env;
    assert.throws(() => preflightRun(scenario, r.workspace, r.dir, open));
    assert.equal(existsSync(remotePaths(r.dir).remote), false, 'remote.git is gone');
  });

  test('a teardown that fails doesn’t hide why the preflight stopped the run', () => {
    const r = run();
    const { GIT_ALLOW_PROTOCOL: _a, GIT_CONFIG_COUNT: _b, ...open } = r.env;
    // A run folder that can’t be written: the teardown can’t keep remote.json, so it throws.
    chmodSync(r.dir, 0o555);
    try {
      assert.throws(() => preflightRun(scenario, r.workspace, r.dir, open), /git in the run isn’t refused an https remote/);
    } finally {
      // Before afterEach removes the folder.
      chmodSync(r.dir, 0o755);
    }
  });
});

test('the run’s stop removes the remote', async () => {
  const r = run();
  const lines = [];
  await runStop({ dir: r.dir, log: (l) => lines.push(l) })();
  assert.equal(existsSync(remotePaths(r.dir).remote), false, lines.join('\n'));
});
