// The lock under races (#508’s storage design, “The data-folder lock”; the 1b invariants, I9): two starters over one stale
// lock, a paused starter inside its takeover, a dead maker’s mutex, a lock published whole or not at all, and unreadable
// contents treated as ambiguous. A closed store that never writes again is in store-failure.test.mjs; a store’s close
// meeting its own late work is in store-close.test.mjs.
import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { disk } from './store-jsonl-fixture.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'pb-lock-race-'));

test('two starters over one stale lock, the second’s rename slow: exactly one holds the folder (gpt’s interleaving)', async () => {
  const { LOCK, lockStore } = await import('../server/store-lock.mjs');
  const dir = await tmp();
  await writeFile(join(dir, LOCK), JSON.stringify({ pid: 2 ** 22 - 7, started: 1, token: 'stale0000' }));
  let renames = 0;
  const io = disk({
    async rename(from, to) {
      if (++renames === 2) await new Promise((r) => setTimeout(r, 40)); // the second starter moves the lock late
      return realFs.rename(from, to);
    },
  });
  const probe = { alive: (pid) => pid === process.pid, started: async () => 1 };
  const results = await Promise.allSettled([lockStore(io, dir, probe), lockStore(io, dir, probe)]);
  const won = results.filter((r) => r.status === 'fulfilled');
  assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.status)));
  const holder = JSON.parse(await readFile(join(dir, LOCK), 'utf8'));
  assert.equal(holder.token, won[0].value.token, 'the lock on disk is the winner’s');
  assert.deepEqual((await readdir(dir)).sort(), [LOCK], 'no mutex or stale file is left behind');
  await rm(dir, { recursive: true });
});

test('a takeover mutex whose maker is gone is never removed: both starters refuse, naming the file to remove', async () => {
  const { LOCK, lockStore } = await import('../server/store-lock.mjs');
  const dir = await tmp();
  await writeFile(join(dir, LOCK), JSON.stringify({ pid: 2 ** 22 - 9, started: 1, token: 'stale0000' }));
  await writeFile(join(dir, `${LOCK}.taking`), JSON.stringify({ pid: 2 ** 22 - 11, started: 1, token: 'deadmaker' }));
  const probe = { alive: (pid) => pid === process.pid, started: async () => 1 };
  const results = await Promise.allSettled([lockStore(realFs, dir, probe), lockStore(realFs, dir, probe)]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['rejected', 'rejected'],
  );
  for (const r of results) assert.match(r.reason.message, /stopped while taking over.*remove .*store\.lock\.taking/);
  assert.deepEqual((await readdir(dir)).sort(), [LOCK, `${LOCK}.taking`], 'nothing was removed for Postbox’s guess');
  await rm(dir, { recursive: true });
});

test('a starter paused inside its takeover keeps the mutex however long it takes: the other waits, then meets its live lock (gpt’s repro)', async () => {
  const { LOCK, lockStore } = await import('../server/store-lock.mjs');
  const dir = await tmp();
  await writeFile(join(dir, LOCK), JSON.stringify({ pid: 2 ** 22 - 7, started: 1, token: 'stale0000' }));
  let resume;
  const paused = new Promise((r) => {
    resume = r;
  });
  let renames = 0;
  const io = disk({
    async rename(from, to) {
      if (++renames === 1) await paused; // the first starter stops just before moving the stale lock aside
      return realFs.rename(from, to);
    },
    async utimes() {}, // nothing ages anything here
  });
  const probe = { alive: (pid) => pid === process.pid, started: async () => 1 };
  const a = lockStore(io, dir, probe);
  // A holds the mutex, paused inside its takeover: wait for the mutex file itself, not a fixed time (the integrator’s nit).
  while (!(await readdir(dir)).includes(`${LOCK}.taking`)) await new Promise((r) => setTimeout(r, 5));
  const b = lockStore(io, dir, probe);
  await new Promise((r) => setTimeout(r, 60)); // B is waiting on A’s mutex, not past it
  // What matters, not the folder listing: B keeps retrying publish() while it waits, and each try leaves a draft for an
  // instant (the integrator’s review of 1a). The stale lock is untouched and nothing was moved aside.
  assert.equal(JSON.parse(await readFile(join(dir, LOCK), 'utf8')).token, 'stale0000', 'the lock is unchanged while A’s mutex stands');
  assert.ok(!(await readdir(dir)).some((n) => n.endsWith('.stale')), 'nothing was moved aside');
  resume();
  const results = await Promise.allSettled([a, b]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['fulfilled', 'rejected'],
  );
  assert.match(results[1].reason.message, /Another Postbox store \(process \d+\) holds/);
  const holder = JSON.parse(await readFile(join(dir, LOCK), 'utf8'));
  assert.equal(holder.token, results[0].value.token, 'the lock on disk is A’s');
  assert.deepEqual((await readdir(dir)).sort(), [LOCK], 'the mutex is gone with its maker’s takeover');
  await rm(dir, { recursive: true });
});

test('a starter paused between creating its lock and filling it can’t be taken for a dead holder: the lock appears whole or not at all (gpt’s repro)', async () => {
  const { LOCK, lockStore } = await import('../server/store-lock.mjs');
  const dir = await tmp();
  let resume;
  const paused = new Promise((r) => {
    resume = r;
  });
  let writes = 0;
  const io = disk({
    async writeFile(path, data, options) {
      const first = ++writes === 1;
      await realFs.writeFile(path, first ? '' : data, options); // A’s record: created empty, filled after the pause
      if (first) {
        await paused;
        await realFs.writeFile(path, data, options);
      }
    },
  });
  const probe = { alive: (pid) => pid === process.pid, started: async () => 1 };
  const a = lockStore(io, dir, probe);
  await new Promise((r) => setTimeout(r, 20)); // A has created its draft, empty, and is paused
  assert.deepEqual(
    (await readdir(dir)).filter((n) => n === LOCK),
    [],
    'nothing is published under the lock’s name yet',
  );
  const b = await lockStore(io, dir, probe); // B finds no lock and takes the folder
  resume();
  await assert.rejects(a, /Another Postbox store \(process \d+\) holds/, 'A, late, meets B’s live lock');
  assert.equal(JSON.parse(await readFile(join(dir, LOCK), 'utf8')).token, b.token);
  assert.deepEqual((await readdir(dir)).sort(), [LOCK], 'A’s draft is gone');
  await rm(dir, { recursive: true });
});

test('a lock whose contents are empty or cut short is ambiguous: the start waits, then refuses naming the file, and removes nothing', async () => {
  const { LOCK, lockStore } = await import('../server/store-lock.mjs');
  for (const contents of ['', '{"pid":12', 'not a pid']) {
    const dir = await tmp();
    await writeFile(join(dir, LOCK), contents);
    await assert.rejects(lockStore(realFs, dir), /unreadable.*remove the file/);
    assert.equal(await readFile(join(dir, LOCK), 'utf8'), contents);
    assert.deepEqual(await readdir(dir), [LOCK]);
    await rm(dir, { recursive: true });
  }
});
