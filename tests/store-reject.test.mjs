// An event the shared reducer rejects (#609, #610; designs/508/609-reducer-throw.md): the store numbers it, writes it
// and holds it as rejected, so numbering never skips, no throw closes the store or crashes the writer, and every load
// gives the same result. The rejected events here are an unknown type, which is a programming error, and a step patch
// on an activity with no steps, which is a data error; both throw before they change anything (the reducer's contract,
// tests/state-reject-contract.test.mjs). The held store is tests/stop-reply-fixture.mjs's.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { liveStreams } from '../server/live-streams.mjs';
import { Store } from '../server/store.mjs';
import { heldStore } from './stop-reply-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const folder = () => tempDir('pb-reject-');
const rejected = (e) => e?.code === 'EREJECTED';
/** The event log's lines, parsed. @param {string} dir */
const logLines = async (dir) =>
  (await readFile(join(dir, 'events-1.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
/** The store at `dir`, loaded again after `store` closes. */
async function reload(store) {
  await store.flush();
  await store.close();
  return new Store(store.dir).load();
}

test('an emit the reducer rejects is numbered and written as rejected: no gap, and the next load reports it, not lost history', async () => {
  const store = await new Store(await folder()).load();
  store.emit('settings', { theme: 'dark' });
  assert.throws(() => store.emit('nonsense', { x: 1 }), rejected);
  const next = store.emit('settings', { theme: 'light' });
  assert.equal(next.seq, 3, 'the next event takes the next seq');
  const again = await reload(store);
  assert.equal(again.lost, null, 'no history reported lost');
  assert.equal(again.rejected?.count, 1);
  assert.deepEqual(
    (await logLines(store.dir)).map((l) => [l.seq, l.type, l.data?.event?.type]),
    [
      [1, 'settings', undefined],
      [2, 'rejected', 'nonsense'],
      [3, 'settings', undefined],
    ],
  );
  assert.equal(again.state.settings.theme, 'light');
  await again.close();
});

test('a held emit the reducer rejects at its release: no crash, the held lines around it reach the disk, and the next seq follows', async () => {
  const h = await heldStore();
  const { store } = h;
  await store.flush();
  h.hold();
  const commit = store.commit([{ type: 'thread', data: { id: 'c', members: [] } }]);
  await h.atSync;
  store.emit('thread', { id: 'a', members: [] });
  store.emit('nonsense', {}); // held: nothing throws until its release
  store.emit('thread', { id: 'b', members: [] });
  h.release();
  await commit;
  await store.flush();
  assert.equal(store.held, 0, 'nothing is left held');
  const next = store.emit('settings', { theme: 'dark' });
  assert.equal(next.seq, store.state.seq);
  assert.equal(next.seq, 5, 'the commit, a, the rejected one, b, then this');
  const again = await reload(store);
  // The rejected line's shape is spec 1's: a held release writes it through the same applyOrHold.
  assert.ok(again.state.threads.a && again.state.threads.b, 'both good held emits are on disk');
  assert.equal(again.rejected?.count, 1);
  assert.equal(again.lost, null);
  await again.close();
});

test('a commit whose event the reducer rejects: the store stays writable, the commit rejects with EREJECTED, and the log loads', async () => {
  const store = await new Store(await folder()).load();
  store.emit('settings', { theme: 'dark' });
  await assert.rejects(store.commit([{ type: 'nonsense', data: {} }]), rejected);
  assert.equal(store.writable, true, 'a write that succeeded doesn’t close the store');
  await store.commit([{ type: 'thread', data: { id: 'after', members: [] } }]);
  const again = await reload(store);
  assert.equal(again.rejected?.count, 1);
  assert.ok(again.state.threads.after);
  assert.equal(again.lost, null);
  await again.close();
});

test('a retry of a rejected commit, by its opId, gets the same rejection, live and after a reload, not a duplicate success', async () => {
  const store = await new Store(await folder()).load();
  await assert.rejects(store.commit([{ type: 'nonsense', data: {} }], { opId: 'op1' }), rejected);
  await assert.rejects(store.commit([{ type: 'nonsense', data: {} }], { opId: 'op1' }), rejected, 'live');
  assert.equal(store.state.seq, 1, 'the retry writes nothing');
  const again = await reload(store);
  await assert.rejects(again.commit([{ type: 'nonsense', data: {} }], { opId: 'op1' }), rejected, 'after a reload');
  assert.equal(again.state.seq, 1);
  await again.close();
});

test('a commit with two rejected events: the rest apply, and its error names the first, live and after a reload', async () => {
  const store = await new Store(await folder()).load();
  const events = [
    { type: 'thread', data: { id: 'one', members: [] } },
    { type: 'nonsense', data: {} },
    { type: 'nonsense', data: { again: true } },
    { type: 'thread', data: { id: 'four', members: [] } },
  ];
  await assert.rejects(store.commit(events, { opId: 'op2' }), (e) => rejected(e) && e.seq === 2);
  const again = await reload(store);
  assert.ok(again.state.threads.one && again.state.threads.four, 'the events around the rejected ones applied on replay');
  await assert.rejects(again.commit(events, { opId: 'op2' }), (e) => rejected(e) && e.seq === 2, 'a retry after a reload names the first too');
  await again.close();
});

test('a snapshot forgets a rejected op, so a retry runs again, and a retry that succeeds is a duplicate after that', async () => {
  const store = await new Store(await folder()).load();
  await assert.rejects(store.commit([{ type: 'nonsense', data: {} }], { opId: 'op3' }), rejected);
  await store.snapshot(); // forgets opIds, as it forgets store.ops
  assert.equal(store.opsRejected.size, 0, 'the snapshot forgot the rejected op');
  const ok = await store.commit([{ type: 'thread', data: { id: 'ok', members: [] } }], { opId: 'op3' });
  assert.equal(ok.duplicate, false, 'after the snapshot the retry runs again');
  assert.deepEqual(await store.commit([{ type: 'thread', data: { id: 'ok', members: [] } }], { opId: 'op3' }), { seq: ok.seq, duplicate: true });
  await store.close();
});

test('what leaves the store for a rejected event names it, but carries none of the reducer’s message', async () => {
  const store = new Store(null);
  const logged = [];
  const error = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    store.emit('item.add', { threadId: 't', item: { id: 'i', kind: 'agent', activity: {} } });
    const e = (() => {
      try {
        store.emit('item.patch', { threadId: 't', id: 'i', activityStep: { id: 'secret-step' } });
      } catch (x) {
        return x;
      }
    })();
    assert.ok(rejected(e));
    assert.doesNotMatch(e.message, /findIndex|secret/, 'the caller’s message, which a tool returns to the agent, names only the seq and type');
    assert.ok(e.cause instanceof TypeError, 'the reducer’s error stays on the cause');
    assert.doesNotMatch(logged.join('\n'), /findIndex|secret/, 'and the log line carries none of it');
  } finally {
    console.error = error;
  }
});

test('a log line the reducer rejects on replay: load completes and holds it as rejected', async () => {
  const dir = await folder();
  const lines = [
    { seq: 1, type: 'settings', data: { theme: 'dark' } },
    { seq: 2, type: 'nonsense', data: {} },
    { seq: 3, type: 'thread', data: { id: 't', members: [] } },
  ];
  await writeFile(join(dir, 'events-1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const store = await new Store(dir).load();
  assert.equal(store.state.seq, 3);
  assert.ok(store.state.threads.t);
  assert.deepEqual(
    store.rejected?.first.map((r) => [r.seq, r.type]),
    [[2, 'nonsense']],
  );
  await store.close();
});

test('a data error, a step patch on an activity with no steps, is rejected the same way', async () => {
  const store = await new Store(await folder()).load();
  store.emit('item.add', { threadId: 't', item: { id: 'i', kind: 'agent', activity: {} } });
  assert.throws(() => store.emit('item.patch', { threadId: 't', id: 'i', activityStep: { id: 's' } }), rejected);
  assert.equal(store.emit('settings', { theme: 'dark' }).seq, 3);
  const again = await reload(store);
  assert.equal(again.lost, null);
  assert.equal(again.rejected?.count, 1);
  await again.close();
});

test('the page: a rejection tells every stream to resync, its stand-in carries nothing, and a backlog from before it resyncs', async () => {
  const store = new Store(null);
  const live = liveStreams(store);
  try {
    const written = [];
    live.streams.add(/** @type {any} */ ({ write: (s) => written.push(String(s)) }));
    store.emit('settings', { theme: 'dark' });
    assert.throws(() => store.emit('nonsense', { secret: 'x' }), rejected);
    const frames = written.join('');
    assert.match(frames, /event: resync\n/);
    assert.doesNotMatch(frames, /secret/, 'nothing of the rejected event reaches the page');
    assert.equal(store.since(1), null, 'a page from before the rejected seq loads the state again');
    assert.deepEqual(store.since(2), [], 'one from after it resumes');
  } finally {
    live.stop(); // its keep-alive timer would hold the run open after a failure
  }
});

test('no producer may emit `rejected` or a stream frame’s name: an emit or a commit of one is refused before anything is numbered', async () => {
  const store = await new Store(await folder()).load();
  store.emit('settings', { theme: 'dark' });
  for (const type of ['rejected', 'cursor', 'status', 'epoch', 'resync']) {
    assert.throws(() => store.emit(type, {}), /reserved/, type);
    await assert.rejects(store.commit([{ type, data: {} }]), /reserved/, type);
  }
  assert.equal(store.ahead, 0);
  assert.equal(store.emit('settings', { theme: 'light' }).seq, 2);
  await store.close();
});

test('what is kept of rejections is bounded: a count, and the first 20', () => {
  const store = new Store(null);
  for (let i = 0; i < 25; i++) assert.throws(() => store.emit('nonsense', { i }), rejected);
  assert.equal(store.rejected?.count, 25);
  assert.equal(store.rejected?.first.length, 20);
  assert.equal(store.rejected?.first[0].seq, 1);
});
