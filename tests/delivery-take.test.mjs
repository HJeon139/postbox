// Delivery’s take (designs/rooms-at-scale.md, “The budget”): a turn takes one thread’s waiting entries, with the notices
// waiting to ride it, in order, up to the budget. The entry that starts the turn is always taken: nothing that arrived
// before it, a notice included, can use the budget up and leave the turn without it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus } from '../server/bus.mjs';
import { Delivery } from '../server/delivery.mjs';
import { Running } from '../server/running.mjs';
import { Store } from '../server/store.mjs';

/** Delivery over beta’s inbox, with beta busy so what’s sent waits, and each entry the size `sizes` gives it. */
function rig(sizes) {
  const store = new Store(null);
  store.emit('session', { id: 'se_b', handle: 'beta', personaId: 'p_beta', threadId: 'th_c', state: 'idle' });
  const running = new Running();
  running.begin({ sessionId: 'se_b' });
  const sizeOf = (/** @type {any} */ e) => sizes[e.itemId ?? e.text] ?? 0;
  return new Delivery({ store, bus: new Bus(), running, chainHeld: () => false, sizeOf });
}

test('a notice that arrived first and fills the budget doesn’t leave out the entry that starts the turn', () => {
  const delivery = rig({ 'Ten chars.': 10, it_1: 1000 });
  delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'notice', text: 'Ten chars.' });
  delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'mention', itemId: 'it_1', from: 'alpha' });
  const taken = delivery.take('se_b', 'tu_1', 500);
  assert.ok(
    taken.some((e) => e.itemId === 'it_1'),
    'the lead is taken, whatever came before it',
  );
  assert.deepEqual(
    delivery.waiting('se_b').filter((e) => e.itemId === 'it_1'),
    [],
  );
});

test('after the lead, entries are taken in order while they fit, and the rest wait in order', () => {
  const delivery = rig({ it_1: 300, it_2: 300, it_3: 100 });
  for (const itemId of ['it_1', 'it_2', 'it_3']) delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'mention', itemId, from: 'alpha' });
  assert.deepEqual(
    delivery.take('se_b', 'tu_1', 500).map((e) => e.itemId),
    ['it_1'],
    'the second would pass the budget, so it and the one after it wait',
  );
  assert.deepEqual(
    delivery.waiting('se_b').map((e) => e.itemId),
    ['it_2', 'it_3'],
  );
});
