// Threads raises item.final once per item, when it is first final (designs/architecture/services.md, “Delivery and Turns,
// built as the inbox”, step 1; designs/rooms-at-scale.md, “What an entry is”). Delivery will turn a final item’s
// mentions into entries, so a mention is handed over only once its message is whole (#834, where one handed over
// mid-stream arrived cut to “I”). An item is final when it’s added, unless it’s a reply still streaming; a streaming
// reply is final when it settles. A block’s revision, a card’s answer or a move makes nothing final again. Built on an
// in-memory store and a bus that records what was emitted; it never builds Runtime.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { Threads } from '../server/threads.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/** A bus that records each signal, in order. */
function recordingBus() {
  const emitted = [];
  return { emitted, on() {}, emit: (signal, data) => emitted.push([signal, data]) };
}

/** Threads over an empty store with one project and one conversation, `th_c`, and a bus that records. */
function rig() {
  const store = new Store(null);
  store.emit('project', { id: 'p1', name: 'P', folder: null });
  const bus = recordingBus();
  const threads = new Threads({ store, bus });
  threads.put({ id: 'th_c', projectId: 'p1', title: 'C', kind: 'thread', parentId: null, members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: 1 });
  return { store, bus, threads };
}

const finals = (bus) => bus.emitted.filter(([s]) => s === 'item.final').map(([, d]) => d);

/** A reply segment as a turn makes one: empty and streaming. */
const streaming = { kind: 'agent', sessionId: 'se_1', handle: 'alpha', turnId: 'tu_1', text: '', status: 'streaming' };

test('a person’s message is final once, when it’s added, with its thread', () => {
  const { bus, threads } = rig();
  const it = threads.addItem('th_c', { kind: 'user', text: 'Hi @alpha', to: ['alpha'] });
  const [only, ...rest] = finals(bus);
  assert.deepEqual(rest, []);
  assert.equal(only.threadId, 'th_c');
  assert.equal(only.item.id, it.id);
  assert.equal(only.item.text, 'Hi @alpha');
  assert.equal(only.thread.id, 'th_c');
});

test('item.final follows item.added for the same item', () => {
  const { bus, threads } = rig();
  threads.addItem('th_c', { kind: 'user', text: 'Hi' });
  assert.deepEqual(
    bus.emitted.map(([s]) => s),
    ['item.added', 'item.final'],
  );
});

test('a block, an app and Postbox’s own items are final once, when they’re added', () => {
  const { bus, threads } = rig();
  const added = [
    threads.addItem('th_c', { kind: 'block', sessionId: 'se_1', handle: 'alpha', block: { id: 'b1', type: 'choice' }, valid: true }),
    threads.addItem('th_c', { kind: 'block', sessionId: 'se_1', handle: 'alpha', block: { id: 'app1', type: 'app' }, valid: true }),
    threads.addItem('th_c', { kind: 'voice', text: 'Allowed: npm test' }),
    threads.addItem('th_c', { kind: 'system', variant: 'joined', to: 'beta' }),
    threads.addItem('th_c', { kind: 'permission', sessionId: 'se_1', status: 'open' }),
  ];
  assert.deepEqual(
    finals(bus).map((d) => d.item.id),
    added.map((it) => it.id),
  );
});

test('a reply that was never streamed, such as a failed one with no words, is final when it’s added', () => {
  const { bus, threads } = rig();
  const it = threads.addItem('th_c', { ...streaming, status: 'failed', error: 'It stopped.' });
  assert.deepEqual(
    finals(bus).map((d) => d.item.id),
    [it.id],
  );
});

test('a streaming reply isn’t final while it streams, nor while its words and steps change', () => {
  const { store, bus, threads } = rig();
  const it = threads.addItem('th_c', streaming);
  store.emit('item.text', { threadId: 'th_c', id: it.id, text: 'I think @beta' });
  threads.patchItem('th_c', it.id, { activity: { steps: [] } });
  threads.patchItem('th_c', it.id, { status: 'streaming' });
  assert.deepEqual(finals(bus), []);
});

test('a reply segment is final once, when it settles, with all of its words', () => {
  const { store, bus, threads } = rig();
  const it = threads.addItem('th_c', streaming);
  store.emit('item.text', { threadId: 'th_c', id: it.id, text: 'I think @beta should look' });
  threads.patchItem('th_c', it.id, { status: 'done' });
  const [only, ...rest] = finals(bus);
  assert.deepEqual(rest, []);
  assert.equal(only.item.id, it.id);
  assert.equal(only.item.text, 'I think @beta should look', 'the whole reply, not the part streamed so far');
  assert.equal(only.item.status, 'done');
  assert.equal(only.thread.id, 'th_c');
});

for (const status of ['failed', 'stopped']) {
  test(`a ${status} reply is final once, when it settles`, () => {
    const { bus, threads } = rig();
    const it = threads.addItem('th_c', streaming);
    threads.patchItem('th_c', it.id, { status });
    assert.deepEqual(
      finals(bus).map((d) => [d.item.id, d.item.status]),
      [[it.id, status]],
    );
  });
}

test('a settled reply settled again, or patched after, isn’t final again', () => {
  const { bus, threads } = rig();
  const it = threads.addItem('th_c', streaming);
  threads.patchItem('th_c', it.id, { status: 'done' });
  threads.patchItem('th_c', it.id, { status: 'done' });
  threads.patchItem('th_c', it.id, { status: 'failed', error: 'It stopped.' });
  threads.patchItem('th_c', it.id, { checkpoint: 'abc' });
  assert.equal(finals(bus).length, 1);
});

test('a block’s revision, a card’s answer and a move to the end make nothing final again', () => {
  const { bus, threads } = rig();
  const block = threads.addItem('th_c', { kind: 'block', sessionId: 'se_1', handle: 'alpha', block: { id: 'b1', type: 'choice', v: 1 }, valid: true });
  const card = threads.addItem('th_c', { kind: 'permission', sessionId: 'se_1', status: 'open' });
  threads.addItem('th_c', { kind: 'user', text: 'Later' });
  const before = finals(bus).length;
  threads.patchItem('th_c', block.id, { block: { id: 'b1', type: 'choice', v: 2 }, answered: true });
  threads.patchItem('th_c', card.id, { status: 'allowed' });
  threads.bringForward('th_c', block.id, { what: 'block', title: 'B1' }, { block: { id: 'b1', type: 'choice', v: 3 } });
  assert.equal(finals(bus).length, before);
});

test('settling an item that doesn’t exist raises nothing', () => {
  const { bus, threads } = rig();
  threads.patchItem('th_c', 'it_nowhere', { status: 'done' });
  assert.deepEqual(finals(bus), []);
});

test('a reply added and settled behind a held commit is final once, whole, as memory will hold it (#601)', async () => {
  const h = await heldStore();
  const bus = recordingBus();
  const threads = new Threads({ store: h.store, bus });
  h.store.emit('project', { id: 'p1', name: 'P', folder: null });
  threads.put({ id: 'th_c', projectId: 'p1', title: 'C', kind: 'thread', parentId: null, members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: 1 });
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync; // the commit is in flight: emits from now on are held behind it
  const it = threads.addItem('th_c', streaming);
  h.store.emit('item.text', { threadId: 'th_c', id: it.id, text: 'Held @beta' });
  threads.patchItem('th_c', it.id, { status: 'done' });
  assert.equal(h.store.item('th_c', it.id), undefined, 'the reply is still held');
  assert.deepEqual(
    finals(bus).map((d) => [d.item.id, d.item.text, d.item.status, d.thread.id]),
    [[it.id, 'Held @beta', 'done', 'th_c']],
  );
  h.release();
  await commit;
  await h.store.close();
});
