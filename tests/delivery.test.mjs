// Delivery’s interface (designs/architecture/services.md, “Delivery and Turns, built as the inbox”; designs/rooms-at-scale.md,
// “What an entry is”): each agent’s inbox in each conversation, as stored entries, and entry.waiting for an agent that
// can start a turn from them. Built on an in-memory store, a real bus and a real Running; it never builds Runtime.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus } from '../server/bus.mjs';
import { Delivery } from '../server/delivery.mjs';
import { Running } from '../server/running.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

/** Delivery over an empty store with two sessions, alpha and beta, in conversation th_c, and a record of entry.waiting. */
function rig({ chainHeld = () => false } = {}) {
  const store = new Store(null);
  for (const [id, handle] of [
    ['se_a', 'alpha'],
    ['se_b', 'beta'],
  ])
    store.emit('session', { id, handle, personaId: `p_${handle}`, threadId: 'th_c', state: 'idle' });
  const bus = new Bus();
  const running = new Running();
  const woke = [];
  bus.on('entry.waiting', ({ sessionId }) => woke.push(sessionId));
  const delivery = new Delivery({ store, bus, running, chainHeld, sizeOf: (e) => (e.text ?? `[${e.itemId}]`).length });
  return { store, bus, running, delivery, woke };
}

/** A mention from alpha to beta, in the conversation unless another thread is given. */
const mention = (itemId, threadId = 'th_c') => ({ sessionId: 'se_b', threadId, source: 'mention', itemId, from: 'alpha' });

test('an entry sent to an idle agent is stored waiting, and raises entry.waiting for it', () => {
  const { store, delivery, woke } = rig();
  const e = delivery.send(mention('it_1'));
  assert.equal(e.state, 'waiting');
  assert.deepEqual(
    store.state.inbox.se_b.map((x) => [x.id, x.itemId, x.state]),
    [[e.id, 'it_1', 'waiting']],
  );
  assert.deepEqual(woke, ['se_b']);
});

test('an entry for a busy agent waits, and raises nothing until the agent is free', () => {
  const { running, delivery, woke } = rig();
  running.begin({ sessionId: 'se_b' });
  delivery.send(mention('it_1'));
  assert.deepEqual(woke, []);
  assert.equal(delivery.waiting('se_b').length, 1);
});

test('a host turn awaiting attach holds its agent’s entries like a running one', () => {
  const { running, delivery, woke } = rig();
  running.awaitAttach('se_b', 'h_1');
  delivery.send(mention('it_1'));
  assert.deepEqual(woke, []);
});

test('an agent whose session failed starts no turn from its entries until the person acts', () => {
  const { store, delivery, woke } = rig();
  store.emit('session.patch', { id: 'se_b', patch: { state: 'failed' } });
  delivery.send(mention('it_1'));
  assert.deepEqual(woke, []);
  assert.equal(delivery.waiting('se_b').length, 1, 'the entry is kept, not dropped');
});

test('at the chain cap an entry still arrives, but starts no turn', () => {
  const { delivery, woke } = rig({ chainHeld: (e) => e.source === 'mention' });
  delivery.send(mention('it_1'));
  assert.deepEqual(woke, []);
  assert.equal(delivery.waiting('se_b').length, 1);
});

test('a notice starts no turn: it rides the next one', () => {
  const { delivery, woke } = rig();
  delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'notice', text: '@gamma isn’t in this conversation.' });
  assert.deepEqual(woke, []);
  delivery.send(mention('it_2'));
  const taken = delivery.take('se_b', 'tu_1');
  assert.deepEqual(
    taken.map((e) => e.source),
    ['notice', 'mention'],
  );
});

test('a source outside the nine is refused, and nothing is stored', () => {
  const { store, delivery } = rig();
  assert.throws(() => delivery.send({ ...mention('it_1'), source: 'wake' }), /source/);
  assert.equal(store.state.inbox.se_b, undefined);
});

test('a retried send with the same retry id is stored once (#1138)', () => {
  const { delivery } = rig();
  const first = delivery.send({ ...mention('it_1'), retryId: 'r_1' });
  const again = delivery.send({ ...mention('it_9'), retryId: 'r_1' });
  assert.equal(again.id, first.id);
  assert.equal(delivery.waiting('se_b').length, 1);
});

test('take holds the oldest entry’s thread only, marks each taken by the turn, and leaves the rest waiting', () => {
  const { delivery } = rig();
  delivery.send(mention('it_1', 'th_topic'));
  delivery.send(mention('it_2'));
  delivery.send(mention('it_3', 'th_topic'));
  const taken = delivery.take('se_b', 'tu_1');
  assert.deepEqual(
    taken.map((e) => [e.itemId, e.state, e.takenBy]),
    [
      ['it_1', 'taken', 'tu_1'],
      ['it_3', 'taken', 'tu_1'],
    ],
  );
  assert.deepEqual(
    delivery.waiting('se_b').map((e) => e.itemId),
    ['it_2'],
  );
});

test('take stops at the budget, in order, and what is past it waits for the next turn; nothing is dropped', () => {
  const { delivery } = rig();
  const own = (text) => ({ sessionId: 'se_b', threadId: 'th_c', source: 'check', text });
  delivery.send(own('a'.repeat(10)));
  delivery.send(own('b'.repeat(10)));
  delivery.send(own('c'.repeat(1)));
  assert.deepEqual(
    delivery.take('se_b', 'tu_1', 15).map((e) => e.text.length),
    [10],
    'the second would pass the budget, so it and the one after it wait, in order',
  );
  assert.deepEqual(
    delivery.take('se_b', 'tu_2', 5).map((e) => e.text.length),
    [10],
    'an entry larger than the budget still goes, alone',
  );
});

test('an entry has an item or its own text, and not both, and keeps no field it wasn’t given', () => {
  const { delivery } = rig();
  assert.throws(() => delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'check' }), /item or its own text/);
  assert.throws(() => delivery.send({ ...mention('it_1'), text: 'copy' }), /item or its own text/);
  const e = delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'notice', text: 'n' });
  assert.equal(Object.hasOwn(e, 'from'), false, 'Postbox’s own entry has no sender');
  assert.equal(Object.hasOwn(e, 'itemId'), false);
});

test('a newer post from the same sender in the thread is noted on its waiting entry, not put in its place', () => {
  const { running, delivery } = rig();
  running.begin({ sessionId: 'se_b' });
  const e = delivery.send(mention('it_1'));
  delivery.postedSince({ threadId: 'th_c', from: 'alpha', itemId: 'it_2' });
  delivery.postedSince({ threadId: 'th_topic', from: 'alpha', itemId: 'it_3' });
  delivery.postedSince({ threadId: 'th_c', from: 'gamma', itemId: 'it_4' });
  const [w] = delivery.waiting('se_b');
  assert.equal(w.id, e.id);
  assert.equal(w.itemId, 'it_1');
  assert.deepEqual(w.postedSince, ['it_2']);
});

test('a turn that ends well marks what it took delivered, and raises entry.waiting for what is left', () => {
  const { running, delivery, woke } = rig();
  running.begin({ sessionId: 'se_b' });
  delivery.send(mention('it_1'));
  delivery.send(mention('it_2', 'th_topic'));
  delivery.take('se_b', 'tu_1');
  running.end('se_b');
  delivery.turnEnded({ sessionId: 'se_b', turnId: 'tu_1' });
  assert.deepEqual(
    delivery.entriesFrom('it_1').map((e) => e.state),
    ['delivered'],
  );
  assert.deepEqual(woke, ['se_b'], 'the topic thread’s entry starts the next turn');
});

test('a turn lost after the harness accepted it reopens its entries once, as a resend; lost again, they fail (#466)', () => {
  const { running, delivery, woke } = rig();
  delivery.send(mention('it_1'));
  delivery.take('se_b', 'tu_1');
  delivery.turnFailed({ sessionId: 'se_b', turnId: 'tu_1', lost: true });
  const [again] = delivery.waiting('se_b');
  assert.equal(again.resend, true);
  assert.deepEqual(woke, ['se_b', 'se_b'], 'the resend starts on its own');
  running.begin({ sessionId: 'se_b' });
  delivery.take('se_b', 'tu_2');
  running.end('se_b');
  delivery.turnFailed({ sessionId: 'se_b', turnId: 'tu_2', lost: true });
  assert.deepEqual(
    delivery.entriesFrom('it_1').map((e) => e.state),
    ['failed'],
  );
});

test('any other failure marks what the turn took delivered: the agent was given it', () => {
  const { delivery } = rig();
  delivery.send(mention('it_1'));
  delivery.take('se_b', 'tu_1');
  delivery.turnFailed({ sessionId: 'se_b', turnId: 'tu_1', lost: false });
  assert.deepEqual(
    delivery.entriesFrom('it_1').map((e) => e.state),
    ['delivered'],
  );
});

test('Retry reopens what the failed turn took, as a resend', () => {
  const { delivery } = rig();
  delivery.send(mention('it_1'));
  delivery.take('se_b', 'tu_1');
  delivery.turnFailed({ sessionId: 'se_b', turnId: 'tu_1', lost: false });
  const reopened = delivery.retry('tu_1');
  assert.deepEqual(
    reopened.map((e) => [e.itemId, e.state, e.resend]),
    [['it_1', 'waiting', true]],
  );
});

test('Stop marks the agent’s waiting entries stopped, and none starts a turn', () => {
  const { delivery, woke } = rig();
  delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'notice', text: 'n' });
  delivery.send(mention('it_2'));
  woke.length = 0;
  const stopped = delivery.stopped('se_b');
  assert.equal(stopped.length, 2);
  assert.deepEqual(delivery.waiting('se_b'), []);
  assert.deepEqual(
    delivery.entriesFrom('it_2').map((e) => e.state),
    ['stopped'],
  );
  delivery.wake('se_b');
  assert.deepEqual(woke, []);
});

test('deleting a session deletes its entries', () => {
  const { store, delivery } = rig();
  delivery.send(mention('it_1'));
  store.emit('remove', { kind: 'session', id: 'se_b' });
  assert.equal(store.state.inbox.se_b, undefined);
  assert.deepEqual(delivery.entriesFrom('it_1'), []);
});

test('on start, an entry taken by a turn with no record of ending reopens once as a resend, and its agent is woken', () => {
  const { delivery, woke } = rig();
  delivery.send(mention('it_1'));
  delivery.take('se_b', 'tu_1');
  woke.length = 0;
  delivery.start();
  const [e] = delivery.waiting('se_b');
  assert.equal(e.resend, true);
  assert.deepEqual(woke, ['se_b']);
});

test('on start, an entry a resend took and lost fails instead of reopening again', () => {
  const { delivery } = rig();
  delivery.send(mention('it_1'));
  delivery.take('se_b', 'tu_1');
  delivery.start();
  delivery.take('se_b', 'tu_2');
  delivery.start();
  assert.deepEqual(
    delivery.entriesFrom('it_1').map((e) => e.state),
    ['failed'],
  );
});

test('on start, an entry a host turn took stays with it while the turn waits to be attached', () => {
  const { running, delivery, woke } = rig();
  delivery.send(mention('it_1'));
  delivery.take('se_b', 'tu_1');
  running.awaitAttach('se_b', 'h_1');
  woke.length = 0;
  delivery.start();
  assert.deepEqual(
    delivery.entriesFrom('it_1').map((e) => [e.state, e.takenBy]),
    [['taken', 'tu_1']],
  );
  assert.deepEqual(woke, []);
});

test('entries are stored as events, so a store reloaded from its log has them', async (t) => {
  const dir = tempDir('pb-delivery-');
  const store = await new Store(dir).load();
  store.emit('session', { id: 'se_b', handle: 'beta', personaId: 'p_beta', threadId: 'th_c', state: 'idle' });
  const delivery = new Delivery({ store, bus: new Bus(), running: new Running(), chainHeld: () => false, sizeOf: () => 0 });
  delivery.send(mention('it_1'));
  await store.flush();
  await store.close();
  const again = await new Store(dir).load();
  t.after(() => again.close());
  assert.deepEqual(
    again.state.inbox.se_b.map((e) => [e.itemId, e.state]),
    [['it_1', 'waiting']],
  );
});
