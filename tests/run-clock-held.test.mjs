// A run clock behind held store writes (server/store-held.mjs): while a commit is in its fsync, emits are held, and the
// published state doesn’t have them yet. The clock’s route, its timer, the turn’s line and Delivery read the clock
// pending, so a clock started, paused or expired then holds and times its agent at once (hydrant-critic’s review of
// #1522: a 1 s clock started behind a held commit was never armed).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armClock, clockAction } from '../server/run-clock.mjs';
import { clockHolds } from '../shared/run-clock.mjs';
import { setup } from './stop-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

const T0 = 1_800_000_000_000;
const at = (ms) => () => T0 + ms;

test('a clock started, paused, resumed and expired behind a held commit acts at once, and publishes as it acted', async () => {
  const h = await heldStore();
  const { rt, store, se } = setup(h.store);
  await store.flush();
  h.hold();
  const held = store.commit([{ type: 'notify', data: { text: 'a commit in its fsync' } }]);
  await h.atSync;
  const started = clockAction(rt, se.id, { action: 'start', budgetS: 1 }, at(0));
  assert.equal(started.clock?.state, 'running', 'the route answers with the clock it started');
  assert.equal(store.state.clocks[se.id], undefined, 'not published yet');
  clockAction(rt, se.id, { action: 'pause' }, at(200));
  assert.equal(clockHolds(store.pending.clock(se.id)), true, 'a paused clock holds the agent before it’s published');
  clockAction(rt, se.id, { action: 'resume' }, at(300));
  // The timer’s check past the budget: 0.2 s used before the pause, then 1 s more.
  armClock(rt, se.id, at(1_400));
  assert.equal(store.pending.clock(se.id).state, 'expired');
  assert.equal(clockHolds(store.pending.clock(se.id)), true);
  h.release();
  await held;
  await store.flush();
  assert.equal(store.state.clocks[se.id].state, 'expired', 'published as it acted');
  await store.close();
});
