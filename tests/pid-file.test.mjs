// #2012: a test reads the pid its child wrote only once the file holds a whole positive number. An empty file, which
// is what a read finds between the child creating the file and writing to it, must never read as pid 0.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pidIn, pidWithin } from './process/pid-file.mjs';
import { tempDir } from './temp-dirs.mjs';

test('a pid file that exists but is still empty holds no pid, and never 0', () => {
  const file = join(tempDir('pid-file-'), 'pid');
  writeFileSync(file, '');
  assert.equal(pidIn(file), null);
});

test('only a whole positive number is a pid: a missing file, 0, a negative and other text are not', () => {
  const dir = tempDir('pid-file-');
  assert.equal(pidIn(join(dir, 'missing')), null);
  for (const text of ['0', '-1', '12a', '1.5', ' ', 'NaN']) {
    writeFileSync(join(dir, 'pid'), text);
    assert.equal(pidIn(join(dir, 'pid')), null, JSON.stringify(text));
  }
  writeFileSync(join(dir, 'pid'), '4242\n'); // as `echo $! > file` writes it
  assert.equal(pidIn(join(dir, 'pid')), 4242);
});

test('the wait goes on past an empty file until the pid is written', async () => {
  const file = join(tempDir('pid-file-'), 'pid');
  writeFileSync(file, '');
  const written = new Promise((ok) => setTimeout(() => ok(writeFileSync(file, '4242')), 100));
  assert.equal(await pidWithin(file, 2000, 10), 4242);
  await written;
});

test('a pid never written fails the wait, saying where it looked and what it found', async () => {
  const file = join(tempDir('pid-file-'), 'pid');
  writeFileSync(file, '');
  await assert.rejects(pidWithin(file, 100, 10), /No pid was written to .*pid within 100 ms: it holds ""\./);
  writeFileSync(file, '0');
  await assert.rejects(pidWithin(file, 50, 10), /it holds "0"\./);
  await assert.rejects(pidWithin(join(file, '..', 'missing'), 50, 10), /missing within 50 ms: it doesn’t exist\./);
});
