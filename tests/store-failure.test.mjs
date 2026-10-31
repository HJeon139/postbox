// What the store does when a write fails and when two stores start on one folder (#508’s storage design, “When a write
// fails”, Q9, and “The data-folder lock”): the first failed sync closes the store to commits and gives back the numbers
// the failed commit took; a flush that can’t sync counts; a repeat of an opId queued behind its original follows its
// result; a stale lock, or a stale takeover mutex, is taken by exactly one of two starters; a snapshot piece never
// splits a surrogate pair.
import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { disk, handleWith } from './store-jsonl-fixture.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'pb-failure-'));

test('Q9: the first failed sync closes the store to commits; later commits and a repeat of the failed opId are refused, emits go on in memory', async () => {
  const dir = await tmp();
  let fail = false;
  const io = disk({
    async open(path, flags, mode) {
      const handle = await (await import('node:fs/promises')).open(path, flags, mode);
      if (!String(path).includes('events-')) return handle;
      return handleWith(handle, {
        sync: () => (fail ? Promise.reject(Object.assign(new Error('disk sync refused'), { code: 'EIO' })) : handle.sync()),
      });
    },
  });
  const s = await new Store(dir, { io }).load();
  await s.commit([{ type: 'thread', data: { id: 'before', members: [] } }], { opId: 'ok' });
  fail = true;
  const heard = [];
  s.subscribe((e) => heard.push(e.type === 'thread' ? e.data.id : e.type));
  const failing = s.commit([{ type: 'thread', data: { id: 'lost', members: [] } }], { opId: 'failed' });
  const held = s.emit('thread', { id: 'meanwhile', members: [] }); // held behind the commit, released when it fails
  await assert.rejects(failing, /EIO/);
  assert.equal(s.writable, false);
  assert.equal(s.state.threads.lost, undefined, 'nothing of the failed commit is applied');
  assert.ok(s.state.threads.meanwhile, 'the held emit was released onto memory');
  assert.ok(held.seq > 0, 'and numbered');
  assert.deepEqual(heard, ['meanwhile'], 'the page heard the emit, not the commit');
  fail = false; // the disk is fine again, but the store stays closed: restarting is the recovery
  await assert.rejects(s.commit([{ type: 'thread', data: { id: 'later', members: [] } }], { opId: 'later' }), /EIO/);
  await assert.rejects(
    s.commit([{ type: 'thread', data: { id: 'lost', members: [] } }], { opId: 'failed' }),
    /EIO/,
    'a repeat of the failed opId is refused too',
  );
  s.emit('thread', { id: 'after', members: [] });
  assert.ok(s.state.threads.after, 'emits keep applying while closed');
  await s.close();
  const b = await new Store(dir).load();
  assert.ok(b.state.threads.before);
  assert.equal(b.state.threads.after, undefined, 'what was emitted while closed was never written');
  assert.equal(b.state.threads.later, undefined);
  await b.close();
  await rm(dir, { recursive: true });
});

test('Q9: the numbers a failed commit took are given back, so the held emit and the next one follow the applied seq', async () => {
  const dir = await tmp();
  let fail = false;
  const io = disk({
    async open(path, flags, mode) {
      const handle = await (await import('node:fs/promises')).open(path, flags, mode);
      if (!String(path).includes('events-')) return handle;
      return handleWith(handle, { sync: () => (fail ? Promise.reject(Object.assign(new Error('disk sync refused'), { code: 'EIO' })) : handle.sync()) });
    },
  });
  const s = await new Store(dir, { io }).load();
  s.emit('thread', { id: 't1', members: [] });
  await s.flush();
  assert.equal(s.state.seq, 1);
  fail = true;
  const failing = s.commit(
    [
      { type: 'thread', data: { id: 'a', members: [] } },
      { type: 'thread', data: { id: 'b', members: [] } },
    ],
    { opId: 'x' },
  );
  const held = s.emit('thread', { id: 'held', members: [] });
  await assert.rejects(failing, /EIO/);
  assert.equal(held.seq, 2, 'the held emit takes the number after the applied seq, not after the failed commit’s');
  assert.equal(s.ahead, 0);
  const next = s.emit('thread', { id: 'next', members: [] });
  assert.equal(next.seq, 3);
  assert.deepEqual(
    s.since(1).map((e) => e.seq),
    [2, 3],
    'the stream has no gap',
  );
  await s.close();
  await rm(dir, { recursive: true });
});

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

test('a snapshot piece never splits a surrogate pair: an emoji across the boundary survives the round trip', async () => {
  const dir = await tmp();
  const { writeSnapshot } = await import('../server/store-commit.mjs');
  const text = `${'x'.repeat((1 << 20) - '{"text":"'.length - 1)}🌙 and on`;
  await writeSnapshot({ io: realFs, at: (n) => join(dir, n), state: { text } });
  assert.equal(JSON.parse(await readFile(join(dir, 'snapshot.json'), 'utf8')).text, text);
  await rm(dir, { recursive: true });
});

test('two commits with one opId queued behind a pending commit: the second gets the first’s seq as a duplicate, written once', async () => {
  const dir = await tmp();
  let gate = null;
  const io = disk({
    async open(path, flags, mode) {
      const handle = await realFs.open(path, flags, mode);
      if (!String(path).includes('events-')) return handle;
      return handleWith(handle, {
        sync: async () => {
          if (gate) await gate;
          return handle.sync();
        },
      });
    },
  });
  const s = await new Store(dir, { io }).load();
  let open;
  gate = new Promise((r) => {
    open = r;
  });
  const change = [{ type: 'thread', data: { id: 'once', members: [] } }];
  const a = s.commit(change, { opId: 'blocker' });
  await new Promise((r) => setTimeout(r, 10)); // the blocker is in its sync
  const b = s.commit(change, { opId: 'same' });
  const c = s.commit(change, { opId: 'same' });
  gate = null;
  open();
  const results = await Promise.all([a, b, c]);
  assert.deepEqual(results, [
    { seq: 1, duplicate: false },
    { seq: 2, duplicate: false },
    { seq: 2, duplicate: true },
  ]);
  assert.equal(s.state.seq, 2, 'the repeat wrote nothing');
  await s.close();
  await rm(dir, { recursive: true });
});

test('a flush whose fsync fails is the first failed sync: the store closes to commits', async () => {
  const dir = await tmp();
  let refuse = false;
  const io = disk({
    async open(path, flags, mode) {
      const handle = await realFs.open(path, flags, mode);
      if (!String(path).includes('events-')) return handle;
      return handleWith(handle, {
        sync: () => (refuse ? Promise.reject(Object.assign(new Error('flush refused'), { code: 'EIO' })) : handle.sync()),
      });
    },
  });
  const s = await new Store(dir, { io }).load();
  s.emit('thread', { id: 't1', members: [] });
  refuse = true;
  await assert.rejects(s.flush(), /EIO/);
  assert.equal(s.writable, false);
  refuse = false;
  await assert.rejects(s.commit([{ type: 'thread', data: { id: 'later', members: [] } }], { opId: 'later' }), /EIO/, 'commits stay refused');
  await s.close();
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
  await new Promise((r) => setTimeout(r, 30)); // A holds the mutex, paused
  const b = lockStore(io, dir, probe);
  await new Promise((r) => setTimeout(r, 60)); // B is waiting on A’s mutex, not past it
  assert.deepEqual((await readdir(dir)).sort(), [LOCK, `${LOCK}.taking`], 'B took nothing while A’s mutex stood');
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
