// A run clock behind held store writes (server/store-held.mjs): while a commit is in its fsync, emits are held, and the
// published state doesn’t have them yet. The clock’s route, its timer, the turn’s line and Delivery read the clock
// pending, so a clock started, paused or expired then holds and times its agent at once (#1526: a 1 s clock started behind a held commit was never armed). No real timer runs: node:test’s mock timers stand
// in for setTimeout and setInterval, so the clocks’ timers never fire on their own; time is injected (`at`).

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { armClock, clockAction } from '../server/run-clock.mjs';
import { clockHolds } from '../shared/run-clock.mjs';
import { clocked as setup } from './run-clock-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

const T0 = 1_800_000_000_000;
const at = (ms) => () => T0 + ms;

test('a clock started, paused, resumed and expired behind a held commit acts at once, and publishes as it acted', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const h = await heldStore();
  const { rt, store, se } = setup(h.store);
  await store.flush();
  h.hold();
  const held = store.commit([{ type: 'notify', data: { text: 'a commit in its fsync' } }]);
  await h.atSync;
  const started = clockAction(rt, se.id, { action: 'start', budgetS: 1 }, at(0));
  assert.equal(started.clock?.state, 'running', 'the route answers with the clock it started');
  assert.equal(store.state.clocks?.[se.id], undefined, 'not published yet');
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

test('the clock’s route refuses a session deleted behind a held commit, and a held deletion takes its clock', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const h = await heldStore();
  const { rt, store, se } = setup(h.store);
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  await store.flush();
  h.hold();
  const held = store.commit([{ type: 'notify', data: { text: 'a commit in its fsync' } }]);
  await h.atSync;
  // The deletion, held: its session is still published, and gone from the pending view.
  store.emit('remove', { kind: 'session', id: se.id });
  assert.ok(store.state.sessions[se.id], 'still published');
  assert.equal(store.pending.clock(se.id), null, 'the held deletion takes the clock');
  assert.throws(() => clockAction(rt, se.id, { action: 'pause' }, at(1_000)), { status: 404 });
  h.release();
  await held;
  await store.flush();
  assert.equal(store.state.clocks[se.id], undefined, 'no orphan clock');
  await store.close();
});
