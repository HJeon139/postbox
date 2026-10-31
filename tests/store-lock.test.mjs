// One store per data folder (server/store.mjs, load() and close(); #508’s PR 1a). Today only the command line claims a
// folder (server/home.mjs, lockData, for bin/postbox.mjs); the store itself takes an exclusive lock file in its data
// folder, so two stores on one log can’t interleave their lines whatever started them. A lock whose process is gone is
// stale and taken over; close() releases it.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'pb-lock-'));
const LOCK = 'store.lock';

test('a store takes a lock file with its pid in the data folder, and a second store on the folder is refused naming it', async () => {
  const dir = await tmp();
  const a = await new Store(dir).load();
  assert.equal(Number(await readFile(join(dir, LOCK), 'utf8')), process.pid, 'the lock names the process holding it');
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
  assert.equal(Number(await readFile(join(dir, LOCK), 'utf8')), process.pid, 'the first store keeps its lock');
  a.emit('thread', { id: 't1', members: [] });
  await a.flush();
  await a.close();
  await rm(dir, { recursive: true });
});

test('a lock left by a process that is gone is stale and replaced; one held by a live process holds', async () => {
  const dir = await tmp();
  await writeFile(join(dir, LOCK), '2147483646'); // no such process
  const a = await new Store(dir).load();
  assert.equal(Number(await readFile(join(dir, LOCK), 'utf8')), process.pid, 'the stale lock was replaced');
  await a.close();
  // The parent process (the test runner) is alive: its lock holds.
  await writeFile(join(dir, LOCK), String(process.ppid));
  await assert.rejects(new Store(dir).load(), new RegExp(String(process.ppid)), 'a live process’s lock refuses the store');
  assert.equal(await readFile(join(dir, LOCK), 'utf8'), String(process.ppid), 'and is left in place');
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
