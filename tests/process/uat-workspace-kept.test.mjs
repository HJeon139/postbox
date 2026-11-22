// #885: a UAT run’s workspace, now outside the Postbox checkout (tests/uat-workspace-outside.test.mjs), stays a git
// repository of its own, and is kept in the run’s folder once the run stops, where --recheck reads it after the temp
// folder is gone. These start git, so they’re process tests.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { savedFacts } from '../../tools/uat/recheck.mjs';
import { makeWorkspace, retainWorkspace, runPaths } from '../../tools/uat/workspace.mjs';
import { tempDir } from '../temp-dirs.mjs';

/** A run folder inside a made-up checkout, and a temp folder elsewhere. */
function layout() {
  const root = realpathSync(tempDir('pb-uat-checkout-'));
  const dir = join(root, 'uat-runs', '2026-11-21T00-00-00-visualskill-bill');
  mkdirSync(dir, { recursive: true });
  return { root, dir, tmp: tempDir('pb-uat-tmp-') };
}

test('#885 the workspace is a git repository of its own: git resolves it as its root', async () => {
  const { root, dir, tmp } = layout();
  const paths = await runPaths(dir, { root, tmp });
  makeWorkspace({ seed: null }, paths, dir);
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: paths.workspace, encoding: 'utf8' });
  assert.equal(top.stdout.trim(), realpathSync(paths.workspace));
});

test('#885 the run keeps its workspace in its folder, and a recheck reads it there after the temp folder is gone', async () => {
  const { root, dir, tmp } = layout();
  const paths = await runPaths(dir, { root, tmp });
  makeWorkspace({ seed: null }, paths, dir);
  writeFileSync(join(paths.workspace, 'notes.md'), 'what the agent wrote\n');
  retainWorkspace(paths);
  retainWorkspace(paths); // once, however often the run’s stop and its exit call it
  assert.equal(existsSync(paths.outside), false, 'the temp folder is removed');
  assert.equal(readFileSync(join(dir, 'workspace', 'notes.md'), 'utf8'), 'what the agent wrote\n');
  assert.ok(existsSync(join(dir, 'workspace', '.git')), 'with its own repository');
  // A recheck reads the agents’ commands against the path they ran in, which run.json keeps; an older run has none.
  const saved = (record) => savedFacts(dir, { state: { threads: {} }, mainId: 't1', saved: {}, logs: [], hostsRec: null, record });
  assert.equal(saved({ workspace: paths.workspace }).workspace, paths.workspace);
  assert.equal(saved(null).workspace, join(dir, 'workspace'), 'a run from before #885');
});

test('#885 a workspace that can’t be kept or removed says so, and never throws from the run’s exit', async () => {
  const { root, dir, tmp } = layout();
  const paths = await runPaths(dir, { root, tmp });
  writeFileSync(join(paths.workspace, 'notes.md'), 'kept\n');
  // Where it’s kept is a file, so the copy fails, as a full disk or a read-only folder would.
  writeFileSync(paths.kept, 'in the way');
  /** @type {string[]} */
  const said = [];
  assert.doesNotThrow(() => retainWorkspace(paths, (l) => said.push(l)));
  assert.match(said[0] ?? '', /Couldn’t keep the workspace in the run’s folder/);
  assert.ok(existsSync(paths.workspace), 'what wasn’t kept isn’t removed either');
});
