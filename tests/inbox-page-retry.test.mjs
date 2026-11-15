// A page left open holds the same inbox as one loaded from /api/state (shared/inbox-page.mjs), through every change of
// an entry: the page drops an entry once it’s delivered, so a change that brings one back from delivered, Retry’s, must
// reach the page whole, not as a patch of an entry it no longer has (the review of #1378).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus } from '../server/bus.mjs';
import { Delivery } from '../server/delivery.mjs';
import { Running } from '../server/running.mjs';
import { Store } from '../server/store.mjs';
import { applyOnPage, pageInbox } from '../shared/inbox-page.mjs';
import { emptyState } from '../shared/state.mjs';

/** Delivery over a store, and a page that has applied every event since the start as the page does. */
function rig() {
  const store = new Store(null);
  const page = emptyState();
  store.subscribe((ev) => applyOnPage(page, ev.type, ev.data));
  store.emit('session', { id: 'se_b', handle: 'beta', personaId: 'p_beta', threadId: 'th_c', state: 'idle' });
  const delivery = new Delivery({ store, bus: new Bus(), running: new Running(), chainHeld: () => false, sizeOf: () => 0 });
  return { store, page, delivery };
}

test('Retry brings a delivered entry back to a page left open, as it is to a page loaded after it', () => {
  const { store, page, delivery } = rig();
  delivery.send({ sessionId: 'se_b', threadId: 'th_c', source: 'mention', itemId: 'it_1', from: 'alpha' });
  delivery.take('se_b', 'tu_1');
  delivery.turnFailed({ sessionId: 'se_b', turnId: 'tu_1', lost: false });
  assert.equal(page.inbox.se_b, undefined, 'delivered, it left the page');
  delivery.retry('tu_1');
  assert.deepEqual(page.inbox, pageInbox(store.state.inbox));
  assert.deepEqual(
    page.inbox.se_b.map((e) => [e.itemId, e.state, e.resend]),
    [['it_1', 'waiting', true]],
  );
});
