// Delivery’s rules for the sources step 3 adds (designs/rooms-at-scale.md, “What an entry is”): the person’s own action,
// an answer or a command, starts a failed agent’s turn, as it did before entries; and an entry that isn’t a plain
// message, such as an answer’s event or a lint turn, is taken alone, never folded into a batch with mentions.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus } from '../server/bus.mjs';
import { Delivery } from '../server/delivery.mjs';
import { Running } from '../server/running.mjs';
import { Store } from '../server/store.mjs';

/** Delivery over beta’s inbox, and a record of each entry.waiting. */
function rig(state = 'idle') {
  const store = new Store(null);
  store.emit('session', { id: 'se_b', handle: 'beta', personaId: 'p_beta', threadId: 'th_c', state });
  const bus = new Bus();
  const woke = [];
  bus.on('entry.waiting', ({ sessionId }) => woke.push(sessionId));
  const delivery = new Delivery({ store, bus, running: new Running(), chainHeld: () => false, sizeOf: () => 0 });
  return { delivery, woke };
}

test('the person’s answer starts a failed agent’s turn, where an agent’s mention waits for the person', () => {
  const { delivery, woke } = rig('failed');
  delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'mention', itemId: 'it_1', from: 'alpha' });
  assert.deepEqual(woke, [], 'a mention waits');
  delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'answer', itemId: 'it_block', from: 'you', message: { kind: 'event', event: {} } });
  assert.deepEqual(woke, ['se_b'], 'the answer starts it');
  assert.deepEqual(
    delivery.take('se_b', 'tu_1').map((e) => e.source),
    ['answer'],
    'and the turn takes the answer, not the mention',
  );
});

test('an entry that isn’t a plain message is taken alone, and the mentions around it wait for the next turn', () => {
  const { delivery } = rig();
  delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'answer', itemId: 'it_block', from: 'you', message: { kind: 'event', event: {} } });
  delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'mention', itemId: 'it_1', from: 'alpha' });
  assert.deepEqual(
    delivery.take('se_b', 'tu_1').map((e) => e.source),
    ['answer'],
  );
  assert.deepEqual(
    delivery.take('se_b', 'tu_2').map((e) => e.source),
    ['mention'],
  );
});

test('a turn that already has its message takes no entry that needs a turn of its own: it waits for the next', () => {
  const { delivery } = rig();
  delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'answer', itemId: 'it_block', from: 'you', message: { kind: 'event', event: {} } });
  assert.deepEqual(delivery.take('se_b', 'tu_1', Number.POSITIVE_INFINITY, 'th_c'), []);
  assert.equal(delivery.waiting('se_b').length, 1);
});
