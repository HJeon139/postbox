// Recovery on load and the snapshot’s write (#508’s storage design, “Recovery on load”, “Snapshots and pruning”;
// tests T-9, T-25, T-27, T-29 and the Q7 guard): a malformed commit line refuses to start naming the file and line; a
// gap in the sequence starts, warns and is recorded; the hand-built fixture with an array line loads whole on the new
// loader; a snapshot.json that is a folder fails the load and changes nothing; the snapshot is written in pieces.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { disk, handleWith } from './store-jsonl-fixture.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'pb-recovery-'));
const ev = (seq, id, extra = {}) => ({ seq, type: 'thread', data: { id, members: [] }, ...extra });
const lines = (...values) => `${values.map((v) => JSON.stringify(v)).join('\n')}\n`;

/** Loads a folder holding one segment with `text`, expecting the refusal `why` names line `n` of the file. */
async function refuses(text, n, why) {
  const dir = await tmp();
  await writeFile(join(dir, 'events-1.jsonl'), text);
  await assert.rejects(new Store(dir).load(), (e) => {
    assert.match(e.message, new RegExp(`line ${n} of events-1\\.jsonl`), e.message);
    assert.match(e.message, why, e.message);
    return true;
  });
  assert.deepEqual((await readdir(dir)).sort(), ['events-1.jsonl'], 'the refusal changes nothing on disk');
  await rm(dir, { recursive: true });
}

test('T-25: an empty commit, a non-event, or non-consecutive seqs in one line refuse to start, naming the line', async () => {
  await refuses(lines(ev(1, 't1'), []), 2, /empty commit/);
  await refuses(lines(ev(1, 't1'), [ev(2, 't2'), { seq: 'three', type: 'thread', data: {} }]), 2, /integer seq/);
  await refuses(lines(ev(1, 't1'), [ev(2, 't2'), ev(4, 't4')]), 2, /consecutive.*2 then 4/);
});

test('T-25: a commit straddling the snapshot’s seq is refused, never applied in part', async () => {
  const dir = await tmp();
  const a = await new Store(dir).load();
  a.emit('thread', { id: 't1', members: [] });
  a.emit('thread', { id: 't2', members: [] });
  await a.snapshot(); // snapshot.json at seq 2; the next segment starts at the first write after it
  await a.close();
  await writeFile(join(dir, 'events-3.jsonl'), lines([ev(2, 't2'), ev(3, 't3')]));
  await assert.rejects(new Store(dir).load(), /seqs 2 to 3, across the snapshot’s 2/);
  await rm(dir, { recursive: true });
});

test('T-9: a gap in seq against the applied seq starts, warns, and is recorded as lost', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'events-1.jsonl'), lines(ev(1, 't1'), ev(5, 't5'), [ev(9, 't9'), ev(10, 't10')]));
  const warnings = [];
  const warn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  let s;
  try {
    s = await new Store(dir).load();
  } finally {
    console.warn = warn;
  }
  assert.equal(s.state.seq, 10);
  assert.deepEqual(Object.keys(s.state.threads).sort(), ['t1', 't10', 't5', 't9']);
  assert.deepEqual(s.lost, { from: 2, to: 8, count: 6 }, 'both gaps, 2–4 and 6–8, in one record');
  assert.equal(warnings.filter((w) => /lost events/.test(w)).length, 2, warnings.join('\n'));
  assert.match(warnings[0], /lost events 2 to 4 \(3\) before line 2 of events-1\.jsonl/);
  s.emit('thread', { id: 'after', members: [] });
  await s.flush();
  assert.equal(s.state.seq, 11, 'the store goes on numbering after the gap');
  await s.close();
  await rm(dir, { recursive: true });
});

test('T-27: the hand-built fixture with a plain line, an array line and a plain line with op loads whole', async () => {
  const dir = await tmp();
  await cp(new URL('./fixtures/store/array-line/', import.meta.url), dir, { recursive: true });
  const s = await new Store(dir).load();
  assert.equal(s.state.seq, 4);
  assert.deepEqual(Object.keys(s.state.threads).sort(), ['t1', 't2', 't3', 't4']);
  assert.deepEqual(await s.commit([{ type: 'thread', data: { id: 'again', members: [] } }], { opId: 'settle-1' }), { seq: 2, duplicate: true });
  assert.deepEqual(await s.commit([{ type: 'thread', data: { id: 'again', members: [] } }], { opId: 'single-1' }), { seq: 4, duplicate: true });
  assert.equal(s.lost, null);
  await s.close();
  await rm(dir, { recursive: true });
});

test('Q7: a snapshot.json that is a folder fails the load naming EISDIR, and nothing on disk changes', async () => {
  const dir = await tmp();
  await mkdir(join(dir, 'snapshot.json'));
  await writeFile(join(dir, 'snapshot.json', 'manifest.json'), '{"seq":1}');
  await writeFile(join(dir, 'events-2.jsonl'), lines(ev(2, 't2')));
  const before = (await readdir(dir)).sort();
  await assert.rejects(new Store(dir).load(), /snapshot\.json.*EISDIR/);
  assert.deepEqual((await readdir(dir)).sort(), before);
  assert.equal(await readFile(join(dir, 'events-2.jsonl'), 'utf8'), lines(ev(2, 't2')));
  await rm(dir, { recursive: true });
});

test('T-29: the snapshot’s text goes to the disk in pieces, not one write', async () => {
  const dir = await tmp();
  let writes = 0;
  const io = disk({
    async open(path, flags, mode) {
      const handle = await (await import('node:fs/promises')).open(path, flags, mode);
      if (!String(path).includes('snapshot.json')) return handle;
      return handleWith(handle, {
        write: (...args) => {
          writes++;
          return handle.write(...args);
        },
      });
    },
  });
  const s = await new Store(dir, { io }).load();
  s.emit('thread', { id: 't1', members: [] });
  s.emit('item.add', { threadId: 't1', item: { id: 'i1', text: 'x'.repeat(2_500_000) } });
  await s.snapshot();
  assert.ok(writes >= 3, `a 2.5 MB snapshot was written in ${writes} write call(s)`);
  await s.close();
  const b = await new Store(dir).load();
  assert.equal(b.state.items.t1[0].text.length, 2_500_000, 'the pieces make the whole text');
  await b.close();
  await rm(dir, { recursive: true });
});

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

const realFs = await import('node:fs/promises');

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

test('a takeover mutex left by a starter that died is removed by exactly one of two new starters, and one of them wins the lock', async () => {
  const { LOCK, lockStore } = await import('../server/store-lock.mjs');
  const dir = await tmp();
  await writeFile(join(dir, LOCK), JSON.stringify({ pid: 2 ** 22 - 9, started: 1, token: 'stale0000' }));
  await mkdir(join(dir, `${LOCK}.taking`));
  const old = new Date(Date.now() - 60_000);
  await realFs.utimes(join(dir, `${LOCK}.taking`), old, old); // older than the stale rule
  const probe = { alive: (pid) => pid === process.pid, started: async () => 1 };
  const results = await Promise.allSettled([lockStore(realFs, dir, probe), lockStore(realFs, dir, probe)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.deepEqual((await readdir(dir)).sort(), [LOCK], 'the stale mutex and its aside name are gone');
  await rm(dir, { recursive: true });
});
