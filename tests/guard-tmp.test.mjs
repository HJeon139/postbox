import assert from 'node:assert/strict';
import fs, { constants, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowHelperPrefix, installTmpGuard, openWrites, outsideRunTemp } from './guard-tmp.mjs';

const RUN = '/tmp/pb-gate-1-AbC123';

test('a write inside the run’s temp folder is allowed, however deep', () => {
  assert.equal(outsideRunTemp(`${RUN}/a/b/c`, RUN), false);
  assert.equal(outsideRunTemp(RUN, RUN), false);
});

test('a fixed path under /tmp, outside the run’s temp folder, is refused', () => {
  assert.equal(outsideRunTemp('/tmp/pb-test-kiro-home', RUN), true);
  assert.equal(outsideRunTemp('/tmp', RUN), true, 'a project folder of /tmp itself');
  assert.equal(outsideRunTemp('/tmp/pb-gate-1-AbC1234/x', RUN), true, 'a sibling whose name starts the same');
});

test('with the run’s folder under another temp folder (as on macOS), both it and /tmp are refused', () => {
  const run = '/srv/scratch/pb-gate-9-ZzZzZz';
  assert.equal(outsideRunTemp('/srv/scratch/pb-test-485', run), true);
  assert.equal(outsideRunTemp('/tmp/pb-test-485', run), true);
  assert.equal(outsideRunTemp(`${run}/pb-test-485-q1`, run), false);
});

test('a path outside every temp folder is the checkout’s or the home’s, so the guard leaves it alone', () => {
  assert.equal(outsideRunTemp('/home/someone/postbox/server/build-commit.txt', RUN), false);
  assert.equal(outsideRunTemp('tests/fixtures/x.json', RUN), false);
});

test('a folder tempDir made outside the run’s folder, for a socket path that wouldn’t fit, is allowed', () => {
  assert.equal(outsideRunTemp('/tmp/pb-sock823-Qw3rty/h/run.sock', RUN), true);
  allowHelperPrefix('/tmp/pb-sock823-');
  assert.equal(outsideRunTemp('/tmp/pb-sock823-Qw3rty/h/run.sock', RUN), false);
  assert.equal(outsideRunTemp('/tmp/pb-other-Qw3rty', RUN), true, 'only under that prefix');
});

test('fs.open counts as a write only with flags that can write', () => {
  for (const flags of ['w', 'a', 'r+', 'wx', constants.O_WRONLY, constants.O_CREAT | constants.O_RDONLY]) assert.equal(openWrites(flags), true, String(flags));
  for (const flags of ['r', undefined, constants.O_RDONLY]) assert.equal(openWrites(flags), false, String(flags));
});

test('once installed, fs refuses a fixed /tmp path and writes nothing there, in its sync, callback and promise forms', async (t) => {
  const run = fs.mkdtempSync(join(tmpdir(), 'pb-gate-823-'));
  t.after(() => fs.rmSync(run, { recursive: true, force: true }));
  installTmpGuard(run);
  const fixed = `/tmp/pb-guard823-${process.pid}`;
  assert.throws(() => fs.mkdirSync(fixed), /outside its run’s temp folder/);
  assert.throws(() => writeFileSync(`${fixed}.named`, 'x'), /outside its run’s temp folder/, 'a named import sees it too');
  assert.throws(() => fs.writeFileSync(`${fixed}.txt`, 'x'), /outside its run’s temp folder/);
  assert.throws(() => fs.openSync(`${fixed}.log`, 'a'), /outside its run’s temp folder/);
  assert.throws(() => fs.mkdir(fixed, () => {}), /outside its run’s temp folder/);
  await assert.rejects(async () => fs.promises.mkdir(fixed), /outside its run’s temp folder/);
  assert.throws(() => fs.renameSync(`${run}/a`, fixed), /outside its run’s temp folder/);
  for (const p of [fixed, `${fixed}.txt`, `${fixed}.log`, `${fixed}.named`]) assert.equal(fs.existsSync(p), false, `${p} wasn’t made`);
  fs.mkdirSync(`${run}/inside`);
  fs.writeFileSync(`${run}/inside/f.txt`, 'x');
  assert.equal(fs.readFileSync(`${run}/inside/f.txt`, 'utf8'), 'x', 'its own folder takes writes');
});
