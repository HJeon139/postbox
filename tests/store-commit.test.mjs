// The store’s commit (server/store.mjs, commit(); #508’s PR 1a, “one-line commit”): several events written as one log
// line, fsynced before any of them is applied, broadcast or served, so a crash leaves all of them or none; an opId that
// makes a retry write nothing; and commits issued together sharing one fsync. The store takes an injectable `io` (its
// node:fs/promises), so a test can count and hold the log’s fsyncs at the fault boundary, without timing.

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { disk, handleWith } from './store-jsonl-fixture.mjs';
import { gate, holding } from './store-kill-fixture.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'pb-commit-'));
const segmentOf = async (dir) => join(dir, /** @type {string} */ ((await readdir(dir)).find((n) => n.startsWith('events-'))));
/** The non-empty lines of the current segment. @param {string} dir */
const lines = async (dir) => (await readFile(await segmentOf(dir), 'utf8')).split('\n').filter((l) => l.trim());
/** @param {string} id */
const thread = (id) => ({ type: 'thread', data: { id, members: [] } });
/** An io whose log segments fsync through `sync(realSync)`. @param {(real: () => Promise<void>) => Promise<void>} sync */
const syncing = (sync) =>
  disk({
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      return /events-\d+\.jsonl$/.test(String(path)) ? handleWith(handle, { sync: () => sync(() => handle.sync()) }) : handle;
    },
  });

test('a commit writes its events as one fsynced log line with their opId, beside old single-event lines, and a reload replays them', async () => {
  const dir = await tmp();
  let syncs = 0;
  const a = await new Store(dir, {
    io: syncing((real) => {
      syncs++;
      return real();
    }),
  }).load();
  a.emit('thread', { id: 't0', members: [] }); // the form every line had before commits
  await a.flush();
  syncs = 0;
  const r = await a.commit([thread('t1'), thread('t2'), { type: 'item.add', data: { threadId: 't1', item: { id: 'i1', text: 'hi' } } }], { opId: 'op-1' });
  assert.deepEqual(r, { seq: 4, duplicate: false }, 'a commit resolves with the seq of its last event (the design, “commit”)');
  assert.ok(syncs >= 1, 'the line was fsynced before the commit resolved');
  assert.equal(a.state.seq, 4);
  const written = await lines(dir);
  assert.equal(written.length, 2, 'one line for the emit, one for the whole commit');
  const line = JSON.parse(written[1]);
  assert.ok(Array.isArray(line), 'a commit’s line is the array of its events');
  assert.equal(line[0].op, 'op-1', 'the opId rides on the first event');
  assert.equal(line[1].op, undefined);
  assert.deepEqual(
    line.map((e) => [e.seq, e.type]),
    [
      [2, 'thread'],
      [3, 'thread'],
      [4, 'item.add'],
    ],
    'each event in the line carries its own consecutive seq',
  );
  await a.close();
  const b = await new Store(dir).load();
  assert.equal(b.state.seq, 4);
  assert.deepEqual(Object.keys(b.state.threads).sort(), ['t0', 't1', 't2']);
  assert.equal(b.state.items.t1[0].text, 'hi');
  await b.close();
  await rm(dir, { recursive: true });
});

test('nothing of a commit is applied, broadcast or served by since() before its fsync', async () => {
  const dir = await tmp();
  const g = gate();
  let hold = false;
  const s = await new Store(dir, {
    io: syncing(async (real) => {
      if (hold) await g.wait();
      await real();
    }),
  }).load();
  s.emit('thread', { id: 't0', members: [] });
  await s.flush();
  const heard = [];
  s.subscribe((ev) => heard.push(ev.seq));
  hold = true;
  let resolved = false;
  const p = s.commit([thread('t1'), thread('t2')], { opId: 'held' }).then((r) => {
    resolved = true;
    return r;
  });
  await holding(g.hit, 'the commit’s line to reach its fsync');
  assert.equal(resolved, false, 'not resolved before the fsync');
  assert.equal(s.state.seq, 1, 'not applied before the fsync: the state is what the disk has');
  assert.equal(s.state.threads.t2, undefined);
  assert.deepEqual(heard, [], 'not broadcast before the fsync');
  assert.deepEqual(s.since(1), [], 'since() doesn’t serve it before the fsync');
  g.go();
  assert.deepEqual(await p, { seq: 3, duplicate: false });
  assert.equal(s.state.seq, 3, 'applied once the fsync is done');
  assert.ok(s.state.threads.t2);
  assert.deepEqual(heard, [2, 3], 'broadcast once the fsync is done, in order');
  assert.deepEqual(
    s.since(1).map((e) => e.seq),
    [2, 3],
  );
  await s.close();
  await rm(dir, { recursive: true });
});

test('an emit while a commit’s fsync is pending is held: numbered, applied and broadcast after the commit, in order', async () => {
  const dir = await tmp();
  const g = gate();
  let hold = false;
  const s = await new Store(dir, {
    io: syncing(async (real) => {
      if (hold) await g.wait();
      await real();
    }),
  }).load();
  s.emit('thread', { id: 't0', members: [] });
  await s.flush();
  const heard = [];
  s.subscribe((ev) => heard.push(`${ev.seq}:${ev.data.id}`));
  hold = true;
  const p = s.commit([thread('c1'), thread('c2')], { opId: 'pending' });
  await holding(g.hit, 'the commit’s line to reach its fsync');
  const ev = s.emit('thread', { id: 'e', members: [] });
  assert.equal(ev.seq, undefined, 'not numbered while the commit is pending');
  assert.equal(s.state.threads.e, undefined, 'not applied while the commit is pending');
  assert.deepEqual(heard, [], 'held behind the commit’s broadcast');
  assert.deepEqual(s.since(1), [], 'and not served ahead of it');
  g.go();
  await p;
  await s.flush();
  assert.equal(ev.seq, 4, 'numbered after the commit’s events, on the object emit() returned');
  assert.ok(s.state.threads.e, 'applied once released');
  assert.deepEqual(heard, ['2:c1', '3:c2', '4:e'], 'the commit’s events, then the emit');
  assert.deepEqual(
    s.since(1).map((e) => e.seq),
    [2, 3, 4],
  );
  const written = (await lines(dir)).map((l) => JSON.parse(l));
  assert.deepEqual(
    written.map((l) => (Array.isArray(l) ? l.map((e) => e.seq) : l.seq)),
    [1, [2, 3], 4],
    'memory, log and stream keep one order',
  );
  await s.close();
  await rm(dir, { recursive: true });
});

test('a commit given a function builds its events from the state the store holds now', async () => {
  const dir = await tmp();
  const s = await new Store(dir).load();
  s.emit('thread', { id: 't', members: [] });
  s.emit('item.add', { threadId: 't', item: { id: 'i', text: 'a' } });
  const r = await s.commit((state) => [{ type: 'item.text', data: { threadId: 't', id: 'i', text: `+${state.items.t[0].text}` } }], { opId: 'fn' });
  assert.deepEqual(r, { seq: 3, duplicate: false });
  assert.equal(s.state.items.t[0].text, 'a+a');
  const r2 = await s.commit(() => [], { opId: 'empty' });
  assert.equal(r2.duplicate, false);
  assert.equal(s.state.seq, 3, 'a commit of no events moves nothing');
  await s.close();
  await rm(dir, { recursive: true });
});

test('a repeated opId writes nothing and returns the first commit’s seq, in the running store and after a reload', async () => {
  const dir = await tmp();
  const a = await new Store(dir).load();
  const first = await a.commit([thread('t1'), thread('t2')], { opId: 'once' });
  assert.deepEqual(first, { seq: 2, duplicate: false }, 'the last seq of the two');
  const size = (await stat(await segmentOf(dir))).size;
  assert.deepEqual(await a.commit([thread('t3')], { opId: 'once' }), { seq: 2, duplicate: true });
  assert.equal(a.state.seq, 2, 'nothing applied');
  assert.equal(a.state.threads.t3, undefined);
  assert.equal((await stat(await segmentOf(dir))).size, size, 'nothing written');
  await a.close();
  const b = await new Store(dir).load();
  assert.deepEqual(await b.commit([thread('t3')], { opId: 'once' }), { seq: 2, duplicate: true }, 'the opIds in the log are remembered across a reload');
  assert.equal(b.state.threads.t3, undefined);
  assert.equal((await stat(await segmentOf(dir))).size, size);
  assert.deepEqual(await b.commit([thread('t3')], { opId: 'twice' }), { seq: 3, duplicate: false }, 'another opId writes');
  await b.close();
  await rm(dir, { recursive: true });
});

test('a snapshot forgets the opIds before it, so a commit with one of them writes again', async () => {
  const dir = await tmp();
  const a = await new Store(dir, { snapshotEvery: 3 }).load();
  await a.commit([thread('t1')], { opId: 'old' });
  assert.deepEqual(await a.commit([thread('t1')], { opId: 'old' }), { seq: 1, duplicate: true }, 'remembered before the snapshot');
  for (let i = 0; i < 3; i++) {
    a.emit('thread', { id: `s${i}`, members: [] });
    await a.flush();
  }
  assert.ok((await readdir(dir)).includes('snapshot.json'), 'the snapshot was taken');
  const again = await a.commit([thread('t9')], { opId: 'old' });
  assert.deepEqual(again, { seq: 5, duplicate: false }, 'forgotten in the running store');
  assert.ok(a.state.threads.t9);
  await a.close();
  const b = await new Store(dir).load();
  assert.ok(b.state.threads.t9, 'and the write is in the log');
  assert.equal(b.state.seq, 5);
  await b.close();
  await rm(dir, { recursive: true });
});

test('commits issued in the same tick share one fsync', async () => {
  const dir = await tmp();
  let syncs = 0;
  const s = await new Store(dir, {
    io: syncing((real) => {
      syncs++;
      return real();
    }),
  }).load();
  s.emit('thread', { id: 't0', members: [] });
  await s.flush();
  syncs = 0;
  const results = await Promise.all([
    s.commit([thread('a')], { opId: 'op-a' }),
    s.commit([thread('b'), thread('c')], { opId: 'op-b' }),
    s.commit([thread('d')], { opId: 'op-c' }),
  ]);
  assert.deepEqual(results, [
    { seq: 2, duplicate: false },
    { seq: 4, duplicate: false },
    { seq: 5, duplicate: false },
  ]);
  assert.equal(syncs, 1, 'one fsync for the three commits');
  assert.equal((await lines(dir)).length, 4, 'still one line per commit');
  await s.close();
  await rm(dir, { recursive: true });
});

// Kill at every byte: a crash leaves the first N bytes of the commit’s line on disk, for each N. The store loads with
// all of the commit’s events or none, never some. tests/process/store-commit-kill.test.mjs does one with a real SIGKILL.
test('a commit line cut at any byte loads with all of the commit’s events or none', async (t) => {
  const dir = await tmp();
  const a = await new Store(dir).load();
  a.emit('thread', { id: 't0', members: [] });
  await a.commit([thread('t1'), thread('t2'), { type: 'item.add', data: { threadId: 't1', item: { id: 'i1', text: 'hi' } } }], { opId: 'cut' });
  await a.flush();
  const text = await readFile(await segmentOf(dir), 'utf8');
  await a.close();
  const cut = text.indexOf('\n') + 1;
  const before = Buffer.from(text.slice(0, cut));
  const line = Buffer.from(text.slice(cut));
  assert.ok(line.length > 50 && line.at(-1) === 0x0a, `the commit’s line, ending in a newline: ${JSON.stringify(text.slice(cut))}`);
  t.mock.method(console, 'warn', () => {}); // the torn line is dropped with a warning each time
  const outcomes = new Set();
  const cutDir = await tmp();
  for (let n = 0; n <= line.length; n++) {
    await writeFile(join(cutDir, 'events-1.jsonl'), Buffer.concat([before, line.subarray(0, n)]));
    const s = await new Store(cutDir).load();
    const threads = Object.keys(s.state.threads).length;
    assert.ok(
      (s.state.seq === 1 && threads === 1) || (s.state.seq === 4 && threads === 3 && s.state.items.t1?.[0]?.text === 'hi'),
      `with ${n} of ${line.length} bytes on disk, the store loaded seq ${s.state.seq} with ${threads} threads: part of a commit`,
    );
    outcomes.add(s.state.seq);
    await s.close();
  }
  assert.deepEqual([...outcomes].sort(), [1, 4], 'both outcomes occur: none with a short prefix, all with the whole line');
  await rm(dir, { recursive: true });
  await rm(cutDir, { recursive: true });
});
