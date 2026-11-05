import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeAll } from '../tools/gate-tmp.mjs';
import { removeTempDirs, tempDir } from './temp-dirs.mjs';

/** A folder of this test’s own to make temp folders in, removed after it whatever happens. */
function root(/** @type {import('node:test').TestContext} */ t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pb-tempdirs-'));
  t.after(() => removeAll(fs, dir));
  return dir;
}

test('the temp folders tempDir made are removed when the test file ends', (t) => {
  const base = root(t);
  const a = tempDir('pb-a-', base);
  const b = tempDir('pb-b-', base);
  fs.writeFileSync(join(a, 'f'), 'x');
  removeTempDirs();
  assert.deepEqual([fs.existsSync(a), fs.existsSync(b)], [false, false]);
  assert.deepEqual(fs.readdirSync(base), []);
});

test('a temp folder with a read-only folder inside is removed too', (t) => {
  const base = root(t);
  const dir = tempDir('pb-ro-', base);
  fs.mkdirSync(join(dir, 'ro'));
  fs.writeFileSync(join(dir, 'ro', 'f'), 'x');
  fs.chmodSync(join(dir, 'ro'), 0o500);
  removeTempDirs();
  assert.equal(fs.existsSync(dir), false);
});
