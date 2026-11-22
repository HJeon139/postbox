// While a run clock holds its agent (#1526, the integrator’s P2 on #1522): Retry and Send now would start a turn the
// clock only holds, in memory, while the reply already said it was retried, so both are refused with a 409, and
// nothing changes. The turns the clock does hold go once none can run: at its expiry, and when the session is
// deleted. The turns are the Stop tests’ scripted adapter. No real timer runs: mock timers stand in for setTimeout,
// setInterval and Date.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { clockAction } from '../server/run-clock.mjs';
import { heldCount } from '../server/run-clock-held.mjs';
import { clocked } from './run-clock-fixture.mjs';
import { slowToExit } from './stop-fixture.mjs';

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 }));
afterEach(() => mock.timers.reset());
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** A clocked agent whose one turn failed, its clock then paused. */
async function failedThenPaused() {
  const f = clocked();
  clockAction(f.rt, f.se.id, { action: 'start', budgetS: 600 });
  f.adapter.next.push(async () => {
    throw new Error('The backend fell over.');
  });
  f.rt.sendMessage(f.t.id, { text: 'Try this.' });
  await settle();
  clockAction(f.rt, f.se.id, { action: 'pause' });
  const failed = f.store.items(f.t.id).findLast((i) => i.kind === 'agent');
  assert.equal(failed.status, 'failed');
  return { ...f, failed };
}

test('Retry while the clock is paused is refused, and the reply stays failed, not retried', async () => {
  const { rt, store, t, adapter, failed } = await failedThenPaused();
  assert.throws(
    () => rt.retry(t.id, failed.id),
    (e) => e.status === 409 && /run clock is paused/.test(e.message),
  );
  await settle();
  assert.equal(store.item(t.id, failed.id).status, 'failed');
  assert.equal(adapter.calls.length, 1, 'no turn');
});

test('Send now while the clock is paused is refused before anything is posted', async () => {
  const { rt, store, t, se } = await failedThenPaused();
  const before = store.items(t.id).length;
  assert.throws(
    () => rt.sendMessage(t.id, { text: '@developer now, please', sendNow: true }),
    (e) => e.status === 409 && /without Send now/.test(e.message),
  );
  assert.equal(store.items(t.id).length, before, 'nothing posted');
  // A plain message waits in the inbox, as the refusal says.
  rt.sendMessage(t.id, { text: 'When you can.' });
  await settle();
  assert.ok((store.state.inbox[se.id] ?? []).some((e) => e.state === 'waiting'));
});

test('the turns a clock holds go at its expiry, and at the session’s delete', async () => {
  const f = clocked();
  clockAction(f.rt, f.se.id, { action: 'start', budgetS: 60 });
  clockAction(f.rt, f.se.id, { action: 'pause' });
  // A notice, which comes another way than the inbox: held for the resume.
  f.rt.turnService.run(f.se.id, { kind: 'notice', text: 'A job you started ended.' });
  assert.equal(heldCount(f.rt, f.se.id), 1);
  clockAction(f.rt, f.se.id, { action: 'resume' });
  await settle();
  assert.equal(heldCount(f.rt, f.se.id), 0, 'the resume ran it');
  // Paused while a stopped turn is still exiting, so the clock counts on to its expiry.
  const turn = slowToExit();
  f.adapter.next.push(turn);
  f.rt.sendMessage(f.t.id, { text: 'Work until paused.' });
  await settle();
  clockAction(f.rt, f.se.id, { action: 'pause' });
  f.rt.turnService.run(f.se.id, { kind: 'notice', text: 'Another.' });
  assert.equal(heldCount(f.rt, f.se.id), 1);
  mock.timers.tick(60_000);
  await settle();
  assert.equal(f.store.state.clocks[f.se.id].state, 'expired');
  assert.equal(heldCount(f.rt, f.se.id), 0, 'none of them can run now');
  turn.exit();
  await settle();
  const g = clocked();
  clockAction(g.rt, g.se.id, { action: 'start', budgetS: 60 });
  clockAction(g.rt, g.se.id, { action: 'pause' });
  g.rt.turnService.run(g.se.id, { kind: 'notice', text: 'Held.' });
  assert.equal(heldCount(g.rt, g.se.id), 1);
  g.rt.deleteSession(g.se.id);
  await settle();
  assert.equal(heldCount(g.rt, g.se.id), 0, 'its session is gone');
});

test('Send now on a queued message while the clock is paused is refused, and the message stays queued', async () => {
  const f = clocked();
  clockAction(f.rt, f.se.id, { action: 'start', budgetS: 600 });
  clockAction(f.rt, f.se.id, { action: 'pause' });
  // A plain message waits in the agent’s inbox while the clock holds it.
  f.rt.sendMessage(f.t.id, { text: 'When you can.' });
  await settle();
  const queued = (f.store.state.inbox[f.se.id] ?? []).find((e) => e.state === 'waiting');
  assert.ok(queued, 'queued');
  assert.throws(
    () => f.rt.sendQueuedNow(f.t.id, queued.id),
    (e) => e.status === 409 && /run clock is paused/.test(e.message),
  );
  await settle();
  assert.equal(f.store.state.inbox[f.se.id].find((e) => e.id === queued.id).state, 'waiting', 'still waiting, not taken');
  assert.equal(heldCount(f.rt, f.se.id), 0, 'nothing held in memory');
  assert.equal(f.adapter.calls.length, 0, 'no turn');
});

test('a turn that comes after the clock expired isn’t held, since it can never run', async () => {
  const f = clocked();
  clockAction(f.rt, f.se.id, { action: 'start', budgetS: 60 });
  mock.timers.tick(60_000);
  await settle();
  assert.equal(f.store.state.clocks[f.se.id].state, 'expired');
  f.rt.turnService.run(f.se.id, { kind: 'notice', text: 'A job you started ended.' });
  f.rt.turnService.run(f.se.id, { kind: 'notice', text: 'And another.' });
  assert.equal(heldCount(f.rt, f.se.id), 0);
  assert.equal(f.adapter.calls.length, 0, 'no turn');
});
