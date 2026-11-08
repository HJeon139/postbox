// tempDir’s folders are removed when the test file’s process exits (#921), not by node:test’s `after`: a file’s own
// `after` still finds its folder, and a file that throws at the top level or calls process.exit(), which skip the
// `after` hooks, leaves nothing. Each case is a test file of its own, run by node --test with TMPDIR set to an empty
// folder, so whatever it leaves there is a folder tempDir didn’t remove.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../temp-dirs.mjs';

const TEMP_DIRS = new URL('../temp-dirs.mjs', import.meta.url).href;

/** Runs `body` as a test file of its own under an empty TMPDIR: what it printed, how it ended, and what it left. */
function run(/** @type {string} */ body) {
  const root = tempDir('pb-tdexit-');
  const tmp = join(root, 'tmp');
  fs.mkdirSync(tmp);
  const file = join(root, 'case.test.mjs');
  fs.writeFileSync(file, `import { tempDir } from ${JSON.stringify(TEMP_DIRS)};\n${body}\n`);
  const env = { ...process.env, TMPDIR: tmp };
  // Without this, the case’s node --test reports to this file’s runner instead of running as a run of its own.
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', file], { env, encoding: 'utf8', timeout: 30_000 });
  return { out: `${r.stdout}${r.stderr}`, status: r.status, left: fs.readdirSync(tmp) };
}

test('a test file’s own after still finds the folder tempDir made, and it’s gone after the file ends', () => {
  const r = run(`import { after, test } from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = tempDir('pb-own-');
after(() => { console.log('own after sees it: ' + existsSync(dir)); writeFileSync(join(dir, 'last'), 'x'); });
test('t', () => {});`);
  assert.match(r.out, /own after sees it: true/, r.out);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.left, []);
});

test('a test file that throws at the top level leaves nothing in the temp folder', () => {
  const r = run(`tempDir('pb-top-');
throw new Error('top-level boom');`);
  assert.match(r.out, /top-level boom/, r.out);
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(r.left, []);
});

test('a test file that calls process.exit leaves nothing in the temp folder', () => {
  const r = run(`import { test } from 'node:test';
test('exits', () => { tempDir('pb-exit-'); process.exit(1); });`);
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(r.left, []);
});
