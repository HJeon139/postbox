// The person’s own actions on one waiting entry (designs/architecture/services.md, “Delivery and Turns, built as the
// inbox”): Remove stops it, and Send now has a turn take it alone, ahead of the others. Each acts only on an entry still
// waiting, so a second click finds nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus } from '../server/bus.mjs';
import { Delivery } from '../server/delivery.mjs';
import { Running } from '../server/running.mjs';
import { Store } from '../server/store.mjs';

/** Delivery with beta busy in a turn, so what’s sent to it waits. */
function rig() {
  const store = new Store(null);
  store.emit('session', { id: 'se_b', handle: 'beta', personaId: 'p_beta', threadId: 'th_c', state: 'idle' });
  const running = new Running();
  running.begin({ sessionId: 'se_b' });
  const delivery = new Delivery({ store, bus: new Bus(), running, chainHeld: () => false, sizeOf: () => 0 });
  const send = (itemId) => delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'mention', itemId, from: 'alpha' });
  return { delivery, send };
}

test('Remove stops one waiting entry and leaves the others waiting; a second Remove finds nothing', () => {
  const { delivery, send } = rig();
  const first = send('it_1');
  send('it_2');
  assert.equal(delivery.cancel('se_b', first.id)?.id, first.id);
  assert.deepEqual(
    delivery.entriesFrom('it_1').map((e) => e.state),
    ['stopped'],
  );
  assert.deepEqual(
    delivery.waiting('se_b').map((e) => e.itemId),
    ['it_2'],
  );
  assert.equal(delivery.cancel('se_b', first.id), null);
});

test('Send now takes one waiting entry for the turn it names, and leaves the others waiting', () => {
  const { delivery, send } = rig();
  send('it_1');
  const second = send('it_2');
  assert.equal(delivery.takeOne('se_b', second.id, 'tu_now')?.takenBy, 'tu_now');
  assert.deepEqual(
    delivery.waiting('se_b').map((e) => e.itemId),
    ['it_1'],
  );
  assert.equal(delivery.takeOne('se_b', second.id, 'tu_again'), null);
});
