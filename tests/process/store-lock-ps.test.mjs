// The lock’s start-time reader off Linux (server/store-lock.mjs, psStart; the 1b invariants, I9): `ps -o lstart=` with
// LC_ALL=C, as an argument array, with a timeout. A live process gives a stable time to the second; a pid that is gone
// gives null, which the lock counts as unknown and the holder as live (fail safe). Runs here, not in the unit suite,
// because tests/guard.mjs bans spawning; the unit specs inject the probe instead.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { test } from 'node:test';
import { psStart, started } from '../../server/store-lock.mjs';

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

test('started() agrees with itself for this process across the two readers it has', async () => {
  const own = await started(fs, process.pid);
  assert.equal(typeof own, 'number');
  if (process.platform !== 'linux') {
    const viaPs = await psStart(process.pid);
    assert.ok(viaPs !== null && Math.abs(viaPs - own) <= 1000, `ps (${viaPs}) and uptime (${own}) agree to the second`);
  }
});
