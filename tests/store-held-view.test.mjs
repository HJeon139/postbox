// The store’s pending read (#601, designs/508/601-held-view.md): an emit made while a commit is queued or in flight is held,
// not yet applied, and every one is released onto memory in order (store-commit.mjs, store-retry.mjs). store.pending
// reads a list with its held emits applied to a copy, for the in-process readers placed in store-held-guard.test.mjs.
// The published reads (store.items(), item(), findItem(), store.state, which /api/state sends, and the stream) see a
// held emit only once it is released, as design.md says a commit is visible to anything only after its sync (T-31).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldStore } from './stop-reply-fixture.mjs';

/** A store on disk with one thread of two items, durable, then a commit held in its fsync: emits from now on are held. */
async function holding() {
  const h = await heldStore();
  const { store } = h;
  store.emit('item.add', { threadId: 't1', item: { id: 'a', kind: 'agent', text: 'one', status: 'done' } });
  store.emit('item.add', { threadId: 't1', item: { id: 'b', kind: 'block', valid: true, block: { id: 'x', type: 'card' } } });
  store.emit('item.add', { threadId: 't2', item: { id: 'c', kind: 'user', text: 'elsewhere' } });
  await store.flush();
  h.hold();
  const commit = store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  const done = async () => {
    h.release();
    await commit;
    await store.flush();
    await store.close();
  };
  return { store, done };
}
const ids = (list) => list.map((i) => i.id);
const pend = (store, threadId, id) => store.pending.items(threadId).find((i) => i.id === id);

test('held item events show in the pending read, in order: an add, a patch, a move and streamed text', async () => {
  const { store, done } = await holding();
  store.emit('item.add', { threadId: 't1', item: { id: 'r', kind: 'agent', text: 'Held', status: 'streaming' } });
  store.emit('item.text', { threadId: 't1', id: 'r', text: ' reply' });
  store.emit('item.patch', { threadId: 't1', id: 'r', patch: { status: 'done' } });
  store.emit('item.move', { threadId: 't1', id: 'a', stub: { id: 'a-stub', kind: 'stub' }, patch: { moved: true } });
  assert.equal(store.held, 4, 'all four are held');
  assert.deepEqual(ids(store.pending.items('t1')), ['a-stub', 'b', 'r', 'a']);
  assert.deepEqual(
    { ...pend(store, 't1', 'r') },
    { id: 'r', kind: 'agent', text: 'Held reply', status: 'done' },
    'the add, its text and its patch, applied in order',
  );
  assert.equal(pend(store, 't1', 'a')?.moved, true);
  assert.equal(store.item('t1', 'r'), undefined, 'the published read doesn’t see it');
  assert.equal(store.findItem('r'), null, 'nor does findItem');
  await done();
});

test('the view is built from the JSON taken at the emit: a caller that changes its object afterwards changes nothing', async () => {
  const { store, done } = await holding();
  const item = { id: 'r', kind: 'agent', text: 'as emitted' };
  store.emit('item.add', { threadId: 't1', item });
  item.text = 'changed after';
  assert.equal(pend(store, 't1', 'r')?.text, 'as emitted');
  await done();
  assert.equal(pend(store, 't1', 'r')?.text, 'as emitted', 'and the release applies the same');
});

test('the pending read mutates no state, and the page doesn’t see a held item: store.state, items() and the stream wait for the release', async () => {
  const { store, done } = await holding();
  const heard = [];
  const off = store.subscribe((ev) => heard.push(ev.type));
  store.emit('item.add', { threadId: 't1', item: { id: 'r', kind: 'agent', text: 'Held' } });
  store.emit('item.patch', { threadId: 't1', id: 'a', patch: { text: 'patched' } });
  assert.equal(pend(store, 't1', 'a')?.text, 'patched', 'the read sees the held patch');
  assert.deepEqual(ids(store.state.items.t1), ['a', 'b'], 'store.state, which /api/state sends, has no held item');
  assert.deepEqual(ids(store.items('t1')), ['a', 'b'], 'nor does the published read');
  assert.equal(store.state.items.t1[0].text, 'one', 'and its item is unpatched');
  assert.deepEqual(heard, [], 'the stream heard nothing');
  assert.deepEqual(ids(store.pending.items('t2')), ['c'], 'another thread’s read is unchanged');
  await done();
  assert.deepEqual(
    heard.filter((type) => type.startsWith('item.')),
    ['item.add', 'item.patch'],
    'released, in order, after the commit',
  );
  off();
});

test('after the release, the visible items are what the view showed', async () => {
  const { store, done } = await holding();
  store.emit('item.add', { threadId: 't1', item: { id: 'r', kind: 'agent', text: 'Held', status: 'streaming' } });
  store.emit('item.text', { threadId: 't1', id: 'r', text: '!' });
  store.emit('item.patch', { threadId: 't1', id: 'b', patch: { valid: false } });
  const view = structuredClone(store.pending.items('t1'));
  await done();
  assert.deepEqual(structuredClone(store.pending.items('t1')), view);
});

test('nothing held: the pending read is the state’s own array', async () => {
  const { store, done } = await holding();
  await done();
  assert.equal(store.pending.items('t1'), store.state.items.t1);
  assert.equal(store.views.size, 0, 'and no view outlives the hold (critic)');
});

test('a long hold stays linear: 1000 held text chunks, each followed by a read, parse each held event once (critic)', async (t) => {
  const { store, done } = await holding();
  store.emit('item.add', { threadId: 't1', item: { id: 'r', kind: 'agent', text: '', status: 'streaming' } });
  const parse = t.mock.method(JSON, 'parse');
  for (let i = 0; i < 1000; i++) {
    store.emit('item.text', { threadId: 't1', id: 'r', text: 'x' });
    assert.equal(pend(store, 't1', 'r')?.text.length, i + 1);
  }
  const parses = parse.mock.callCount();
  parse.mock.restore();
  assert.ok(parses <= 1001 + 10, `each held event parsed about once, not once per read: ${parses}`);
  await done();
});

test('a conversation’s held work entries show in the pending work read: the ledger reads its own entries throughout a turn', async () => {
  const { store, done } = await holding();
  store.emit('work.add', { convId: 't1', entry: { id: 'w1', kind: 'turn', status: 'running' } });
  store.emit('work.patch', { convId: 't1', id: 'w1', patch: { status: 'done' } });
  assert.deepEqual(
    store.pending.work('t1').map((e) => [e.id, e.status]),
    [['w1', 'done']],
  );
  assert.equal(store.state.work?.t1, undefined, 'not in the state the page reads');
  await done();
  assert.deepEqual(
    store.pending.work('t1').map((e) => [e.id, e.status]),
    [['w1', 'done']],
  );
});

test('a write that fails under a hold, then Retry: nothing read pending survives, and the pending and published reads agree', async () => {
  const h = await heldStore();
  const { store } = h;
  store.emit('item.add', { threadId: 't1', item: { id: 'a', kind: 'agent', text: 'durable', status: 'done' } });
  await store.flush();
  h.hold();
  const commit = store.commit([{ type: 'settings', data: { theme: 'system' } }]).catch((e) => e);
  await h.atSync;
  store.emit('item.add', { threadId: 't1', item: { id: 'r', kind: 'agent', text: 'Held', status: 'streaming' } });
  assert.ok(pend(store, 't1', 'r'), 'read pending');
  store.emit('item.patch', { threadId: 't1', id: 'r', patch: { status: 'done' } }); // a decision made on that read
  store.fail(Object.assign(new Error('disk sync refused'), { code: 'EIO' }));
  h.release();
  await commit; // the commit already in its fsync settles; the emits held behind it were released onto memory only
  assert.equal(store.item('t1', 'r')?.status, 'done', 'fail() released both onto memory');
  await store.reload(); // Retry installs what the disk holds
  assert.deepEqual(ids(store.items('t1')), ['a'], 'the held reply and its patch are gone with the failure');
  assert.equal(store.pending.items('t1'), store.items('t1'), 'the two reads agree');
  assert.deepEqual({ held: store.held, heldLog: store.heldLog.length, views: store.views.size }, { held: 0, heldLog: 0, views: 0 });
  await store.close();
});

test('a held event the reducer rejects: the read throws as the release will, every time, drops its view, and leaves the rest answering (critic)', async () => {
  const h = await heldStore();
  const { store } = h;
  // A real rejection: a step patch on an item whose activity has no steps throws in applyItemPatch (shared/state.mjs).
  store.emit('item.add', { threadId: 't1', item: { id: 'a', kind: 'agent', text: 'one', activity: {} } });
  store.emit('item.add', { threadId: 't2', item: { id: 'c', kind: 'user', text: 'elsewhere' } });
  await store.flush();
  h.hold();
  const commit = store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  store.emit('item.patch', { threadId: 't1', id: 'a', activityStep: { id: 's1', label: 'Read' } });
  const first = (() => {
    try {
      store.pending.items('t1');
    } catch (e) {
      return e;
    }
  })();
  assert.ok(first instanceof TypeError, 'the read throws, as apply will at release');
  assert.equal(store.views.has('items:t1'), false, 'and keeps no view that has seen part of an event');
  assert.throws(() => store.pending.items('t1'), { message: first.message }, 'again, the same way');
  assert.deepEqual(JSON.parse(JSON.stringify(store.state.items.t1)), [{ id: 'a', kind: 'agent', text: 'one', activity: {} }], 'published untouched');
  assert.deepEqual(ids(store.pending.items('t2')), ['c'], 'another thread’s read still answers');
  // The release would throw in the writer too (#610). So the spec can end, the item is given its steps first: a test’s
  // own repair, not something the server does.
  store.state.items.t1[0].activity.steps = [];
  h.release();
  await commit;
  await store.flush();
  await store.close();
});

test('a malformed held add (no item) is taken by the pending read as the release takes it, without throwing (gpt)', async () => {
  const { store, done } = await holding();
  store.emit('item.add', { threadId: 't1' });
  assert.doesNotThrow(() => store.pending.items('t1'));
  await done();
});
