// One store per data folder (server/store-lock.mjs; #508’s storage design, “The data-folder lock”). Today only the
// command line claims a folder (server/home.mjs, lockData, for bin/postbox.mjs); the store itself takes an exclusive
// lock file in its data folder, naming its process (pid and start time) and a token of its own, so two stores on one
// log can’t interleave their lines whatever started them. A lock whose process is gone, or whose pid is alive but
// started at another time, is stale and taken over by renaming it aside first, so of two takeovers exactly one wins;
// close() releases a lock only while it still carries this store’s token.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { lockStore, unlockStore } from '../server/store-lock.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'pb-lock-'));
const LOCK = 'store.lock';
/** What the lock file says. @param {string} dir */
const holder = async (dir) => JSON.parse(await readFile(join(dir, LOCK), 'utf8'));

test('a store takes a lock file naming its process in the data folder, and a second store on the folder is refused naming it', async () => {
  const dir = await tmp();
  const a = await new Store(dir).load();
  const lock = await holder(dir);
  assert.equal(lock.pid, process.pid, 'the lock names the process holding it');
  assert.ok(typeof lock.token === 'string' && lock.token.length >= 8, `and carries a token of the store’s own: ${lock.token}`);
  const other = new Store(dir);
  await assert.rejects(
    other.load(),
    (e) => {
      assert.ok(e.message.includes(dir), `names the folder: ${e.message}`);
      assert.ok(e.message.includes(String(process.pid)), `names the pid holding it: ${e.message}`);
      return true;
    },
    'a second store on the same folder is refused',
  );
  assert.deepEqual(await holder(dir), lock, 'the first store keeps its lock');
  a.emit('thread', { id: 't1', members: [] });
  await a.flush();
  await a.close();
  await rm(dir, { recursive: true });
});

test('a lock left by a process that is gone is stale and replaced; one held by a live process holds', async () => {
  const dir = await tmp();
  await writeFile(join(dir, LOCK), '2147483646'); // no such process: a lock as the first stores wrote it, a bare pid
  const a = await new Store(dir).load();
  assert.equal((await holder(dir)).pid, process.pid, 'the stale lock was replaced');
  await a.close();
  // The parent process (the test runner) is alive: its lock holds.
  await writeFile(join(dir, LOCK), String(process.ppid));
  await assert.rejects(new Store(dir).load(), new RegExp(String(process.ppid)), 'a live process’s lock refuses the store');
  assert.equal(await readFile(join(dir, LOCK), 'utf8'), String(process.ppid), 'and is left in place');
  await rm(dir, { recursive: true });
});

test('a lock whose pid is alive but started at another time belongs to a process that is gone, and is taken over', async () => {
  const dir = await tmp();
  const a = await lockStore(fs, dir);
  const mine = await holder(dir);
  await unlockStore(fs, a);
  await writeFile(join(dir, LOCK), JSON.stringify({ ...mine, started: (mine.started ?? 0) - 60_000, token: 'ofanother' }));
  const b = await lockStore(fs, dir);
  assert.equal((await holder(dir)).token, b.token, 'the pid was reused: the lock is stale, and taken over');
  await unlockStore(fs, b);
  await rm(dir, { recursive: true });
});

test('two stores that find the same lock stale and take it over at once: exactly one wins', async () => {
  const dir = await tmp();
  await writeFile(join(dir, LOCK), JSON.stringify({ pid: 2147483646, started: 1, token: 'stale' }));
  const probe = { alive: (pid) => pid === process.pid }; // the stale pid is gone, this process is here
  const outcomes = await Promise.allSettled([lockStore(fs, dir, probe), lockStore(fs, dir, probe)]);
  const won = outcomes.filter((o) => o.status === 'fulfilled');
  const lost = outcomes.filter((o) => o.status === 'rejected');
  assert.equal(won.length, 1, `one takeover wins: ${JSON.stringify(outcomes.map((o) => o.status))}`);
  assert.equal(lost.length, 1);
  assert.match(/** @type {any} */ (lost[0]).reason.message, new RegExp(String(process.pid)), 'the other is refused naming the winner');
  assert.equal((await holder(dir)).token, /** @type {any} */ (won[0]).value.token, 'the winner’s lock is the one in the folder');
  assert.deepEqual(
    (await fs.readdir(dir)).filter((n) => n !== LOCK),
    [],
    'the stale lock, moved aside, is gone',
  );
  await unlockStore(fs, /** @type {any} */ (won[0]).value);
  await rm(dir, { recursive: true });
});

test('a release leaves a lock another store took over meanwhile: only the lock carrying this store’s token goes', async () => {
  const dir = await tmp();
  const a = await lockStore(fs, dir);
  await writeFile(join(dir, LOCK), JSON.stringify({ pid: process.pid, started: null, token: 'thenext' })); // as a takeover after a crash leaves it
  await unlockStore(fs, a);
  assert.equal((await holder(dir)).token, 'thenext', 'not this store’s lock: left alone');
  const b = await lockStore(fs, dir, { alive: () => false });
  await unlockStore(fs, b);
  assert.equal(existsSync(join(dir, LOCK)), false, 'its own lock goes');
  await rm(dir, { recursive: true });
});

test('close() flushes what is queued and releases the lock, so the next store on the folder loads', async () => {
  const dir = await tmp();
  const a = await new Store(dir).load();
  a.emit('thread', { id: 't1', members: [] });
  await a.close();
  assert.equal(existsSync(join(dir, LOCK)), false, 'the lock is gone');
  const b = await new Store(dir).load();
  assert.ok(b.state.threads.t1, 'what was queued at close() is in the log');
  await b.close();
  await rm(dir, { recursive: true });
});
