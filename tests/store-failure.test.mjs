// What the store does when a write fails and when two stores start on one folder (#508’s storage design, “When a write
// fails”, Q9, and “The data-folder lock”): the first failed sync closes the store to commits and gives back the numbers
// the failed commit took; a flush that can’t sync counts; a repeat of an opId queued behind its original follows its
// result; a stale lock, or a stale takeover mutex, is taken by exactly one of two starters; a snapshot piece never
// splits a surrogate pair.
import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

test('a closed store never writes again: a late emit is dropped and a late commit refused, while the next store holds the folder', async () => {
  const dir = await tmp();
  const a = await new Store(dir).load();
  a.emit('thread', { id: 'a1', members: [] });
  await a.close();
  const b = await new Store(dir).load(); // the folder is B’s now
  b.emit('thread', { id: 'b1', members: [] });
  await b.flush();
  const late = a.emit('thread', { id: 'a-late', members: [] }); // an adapter’s exit callback after shutdown
  assert.equal(late.seq, undefined, 'applied nowhere');
  await assert.rejects(a.commit([{ type: 'thread', data: { id: 'a-commit', members: [] } }], { opId: 'late' }), /closed/);
  await b.close();
  const c = await new Store(dir).load();
  assert.deepEqual(Object.keys(c.state.threads).sort(), ['a1', 'b1'], 'the log holds only what the folder’s holders wrote, in order');
  assert.equal(c.state.seq, 2);
  await c.close();
  await rm(dir, { recursive: true });
});
