// Delivery reads behind a held commit (#796’s class, #1292): an entry written while a commit is held is in the pending
// state, not the published one, and every read that decides a write finds it there (server/store-held.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus } from '../server/bus.mjs';
import { Delivery } from '../server/delivery.mjs';
import { Running } from '../server/running.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/** A mention from alpha to beta in the conversation. */
const mention = (itemId) => ({ sessionId: 'se_b', threadId: 'th_c', source: 'mention', itemId, from: 'alpha' });

test('an inbox’s first entry written behind a held commit is found by entriesFrom and postedSince before its release (#796’s class)', async () => {
  const h = await heldStore();
  const { store } = h;
  store.emit('session', { id: 'se_b', handle: 'beta', personaId: 'p_beta', threadId: 'th_c', state: 'idle' });
  const running = new Running();
  running.begin({ sessionId: 'se_b' });
  const delivery = new Delivery({ store, bus: new Bus(), running, chainHeld: () => false, sizeOf: () => 0 });
  await store.flush();
  h.hold();
  const commit = store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  delivery.send(mention('it_1'));
  assert.equal(store.state.inbox.se_b, undefined, 'held: nothing published yet');
  assert.deepEqual(
    delivery.entriesFrom('it_1').map((e) => e.state),
    ['waiting'],
  );
  delivery.postedSince({ threadId: 'th_c', from: 'alpha', itemId: 'it_2' });
  assert.deepEqual(delivery.waiting('se_b')[0].postedSince, ['it_2']);
  h.release();
  await commit;
  await store.flush();
  assert.deepEqual(store.state.inbox.se_b[0].postedSince, ['it_2']);
  await store.close();
});
