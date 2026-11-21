// #885: a UAT run’s workspace lies outside the Postbox checkout, so an agent that reads above it can’t reach the
// visual skill’s briefs, which state each answer. A made-up checkout stands in for Postbox’s: a run folder under its
// uat-runs/, and a brief under designs/skills/visual-explainer/briefs/. That it stays a git repository and is kept in
// the run’s folder starts git, so it’s in tests/process/uat-workspace-kept.test.mjs.

import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { runPaths } from '../tools/uat/run-files.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A checkout with a brief in it, a run folder inside it, and a temp folder elsewhere. */
function layout() {
  const checkout = realpathSync(tempDir('pb-uat-checkout-'));
  const briefs = join(checkout, 'designs', 'skills', 'visual-explainer', 'briefs');
  mkdirSync(briefs, { recursive: true });
  writeFileSync(join(briefs, 'flaky-tests.md'), 'The answer: six tests cause 76% of the failures.\n');
  const dir = join(checkout, 'uat-runs', '2026-11-21T00-00-00-visualskill-bill');
  mkdirSync(dir, { recursive: true });
  return { checkout, dir, tmp: tempDir('pb-uat-tmp-') };
}

/** Every folder from `from` up to the root, each one’s entries listed, as an agent listing parents would see them. */
function seenAbove(from) {
  const seen = [];
  for (let d = dirname(from); ; d = dirname(d)) {
    try {
      seen.push(...readdirSync(d).map((e) => join(d, e)));
    } catch {}
    if (dirname(d) === d) break;
  }
  return seen;
}

test('#885 the workspace’s real path is outside the checkout and the run’s folder, and nothing above it is a brief', async () => {
  const { checkout, dir, tmp } = layout();
  const paths = await runPaths(dir, { root: checkout, tmp });
  const real = realpathSync(paths.workspace);
  assert.ok(!real.startsWith(checkout + sep), `${real} is inside the checkout`);
  assert.ok(!real.startsWith(realpathSync(dir) + sep), `${real} is inside the run’s folder`);
  assert.equal(
    seenAbove(real).some((p) => p.startsWith(join(checkout, 'designs'))),
    false,
    'no folder above the workspace lists the checkout’s designs/',
  );
});

test('#885 a temp folder inside the checkout is refused, as the workspace would be under the checkout again', async () => {
  const { checkout, dir } = layout();
  const inside = join(checkout, 'tmp');
  mkdirSync(inside);
  await assert.rejects(runPaths(dir, { root: checkout, tmp: inside }), /is inside the Postbox checkout.*Set TMPDIR to a folder outside/);
  await assert.rejects(runPaths(dir, { root: checkout, tmp: checkout }), /is inside the Postbox checkout/);
  assert.deepEqual(readdirSync(inside), [], 'and nothing is made there');
});

test('#885 a run whose folders can’t be made leaves no temp folder behind, and says why', async () => {
  const { checkout, dir, tmp } = layout();
  writeFileSync(join(dir, 'data'), 'a file where the data folder goes');
  await assert.rejects(runPaths(dir, { root: checkout, tmp }), { code: 'EEXIST' });
  assert.deepEqual(readdirSync(tmp), [], 'no workspace folder was made');
});
