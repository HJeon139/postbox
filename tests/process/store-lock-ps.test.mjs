// The lock’s start-time reader off Linux (server/store-lock.mjs, psStart; the 1b invariants, I9): one source for the
// writer and every reader. A live process gives a stable time to the second; a pid that is gone gives null, which the
// lock counts as unknown and the holder as live (fail safe). A lock held by another live process refuses this one, and
// is taken over once that process is gone (gpt’s finding on 1b: two sources differed by a second and a live holder read
// as stale). Runs here, not in the unit suite, because tests/guard.mjs bans spawning.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOCK, lockStore, psStart, started, unlockStore } from '../../server/store-lock.mjs';

test('ps gives a live process a start time to the second, the same twice, and a gone process none', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  try {
    const a = await psStart(child.pid);
    const b = await psStart(child.pid);
    assert.equal(typeof a, 'number', `a start time, not ${a}`);
    assert.equal(a % 1000, 0, 'to the second');
    assert.equal(a, b, 'stable between two reads');
    assert.ok(Math.abs(a - Date.now()) < 60_000, 'about now');
  } finally {
    child.kill('SIGKILL');
  }
  await new Promise((r) => child.once('exit', r));
  assert.equal(await psStart(child.pid), null, 'a process that is gone has no start time: unknown, which counts as live');
});

test('this process’s own start time comes from the same reader as another’s, so they agree exactly', async () => {
  const own = await started(fs, process.pid);
  assert.equal(typeof own, 'number');
  if (process.platform !== 'linux') assert.equal(own, await psStart(process.pid));
});

test('a lock held by another live process refuses this one, and is taken over once that process is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-lock-live-'));
  const here = new URL('../../server/store-lock.mjs', import.meta.url).pathname;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { lockStore } from ${JSON.stringify(here)}; import * as fs from 'node:fs/promises'; await lockStore(fs, ${JSON.stringify(dir)}); process.stdout.write('LOCKED\\n'); setTimeout(() => {}, 20000);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise((r, j) => {
    child.stdout.on('data', (d) => String(d).includes('LOCKED') && r());
    child.once('exit', (c) => j(new Error(`the child exited early (${c})`)));
  });
  try {
    await assert.rejects(lockStore(fs, dir), /Another Postbox store \(process \d+\) holds .*remove .*store\.lock/);
  } finally {
    child.kill('SIGKILL');
  }
  await new Promise((r) => child.once('exit', r));
  const lock = await lockStore(fs, dir); // the holder is gone: stale, taken over
  assert.ok(lock.token);
  await unlockStore(fs, lock);
  assert.ok(!(await fs.readdir(dir)).includes(LOCK));
  await rm(dir, { recursive: true, force: true });
});
