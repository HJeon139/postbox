// #885: a UAT run’s workspace, now outside the Postbox checkout (tests/uat-workspace-outside.test.mjs), stays a git
// repository of its own, and is kept in the run’s folder once the run stops, where --recheck reads it after the temp
// folder is gone. These start git, so they’re process tests.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { savedFacts } from '../../tools/uat/recheck.mjs';
import { retainWorkspace, runPaths } from '../../tools/uat/run-files.mjs';
import { makeWorkspace } from '../../tools/uat/workspace.mjs';
import { tempDir } from '../temp-dirs.mjs';

/** A run folder inside a made-up checkout, and a temp folder elsewhere. */
function layout() {
  const dir = join(realpathSync(tempDir('pb-uat-checkout-')), 'uat-runs', '2026-11-21T00-00-00-visualskill-bill');
  mkdirSync(dir, { recursive: true });
  return { dir, tmp: tempDir('pb-uat-tmp-') };
}

test('#885 the workspace is a git repository of its own: git resolves it as its root', async () => {
  const { dir, tmp } = layout();
  const paths = await runPaths(dir, { tmp });
  makeWorkspace({ seed: null }, paths, dir);
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: paths.workspace, encoding: 'utf8' });
  assert.equal(top.stdout.trim(), realpathSync(paths.workspace));
});

test('#885 the run keeps its workspace in its folder, and a recheck reads it there after the temp folder is gone', async () => {
  const { dir, tmp } = layout();
  const paths = await runPaths(dir, { tmp });
  makeWorkspace({ seed: null }, paths, dir);
  writeFileSync(join(paths.workspace, 'notes.md'), 'what the agent wrote\n');
  retainWorkspace(paths);
  retainWorkspace(paths); // once, however often the run’s stop and its exit call it
  assert.equal(existsSync(paths.outside), false, 'the temp folder is removed');
  assert.equal(readFileSync(join(dir, 'workspace', 'notes.md'), 'utf8'), 'what the agent wrote\n');
  assert.ok(existsSync(join(dir, 'workspace', '.git')), 'with its own repository');
  const facts = savedFacts(dir, { state: { threads: {} }, mainId: 't1', saved: {}, logs: [], hostsRec: null, record: null });
  assert.equal(facts.workspace, join(dir, 'workspace'));
  assert.ok(existsSync(join(facts.workspace, 'notes.md')), 'the recheck reads the kept workspace');
});
