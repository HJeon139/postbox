// #1749: a timed run ended early had only a pause, so it showed as paused, not ended, and a later resume started it
// again. The person’s stop ends the clock for good: it records clock.ended, stops the agent’s turn as a pause does,
// holds the agent as an expiry does, and refuses a later resume.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { clockAction, rearmClocks, stopHeldTurn } from '../server/run-clock.mjs';
import { heldCount, holdForClock } from '../server/run-clock-held.mjs';
import { clockElapsed, clockHolds } from '../shared/run-clock.mjs';
import { apply, emptyState, PUBLIC_EVENT_TYPES } from '../shared/state.mjs';
import { waitingEntries } from './arrange.mjs';
import { clocked as setup } from './run-clock-fixture.mjs';
import { slowToExit } from './stop-fixture.mjs';

const T0 = 1_800_000_000_000;
beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 }));
afterEach(() => mock.timers.reset());
/** Lets the scripted turns settle, then moves the mock clock on by `ms`, and lets what that fires settle. */
async function sleep(ms) {
  const turns = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  await turns();
  mock.timers.tick(ms);
  await turns();
}
const at = (ms) => () => T0 + ms;
const clockLines = (store, t) => store.items(t.id).filter((i) => i.kind === 'system' && i.variant === 'clock');

test('#1749 the store keeps an ended clock’s time used, not its budget, and it holds its agent', () => {
  const s = emptyState();
  apply(s, 'clock.started', { sessionId: 'se_1', threadId: 'th_1', budgetMs: 60_000, at: T0 });
  apply(s, 'clock.ended', { sessionId: 'se_1', elapsedMs: 12_000, budgetMs: 60_000, at: T0 + 12_000 });
  const c = s.clocks.se_1;
  assert.equal(c.state, 'ended');
  assert.equal(clockElapsed(c, T0 + 99_000), 12_000, 'it stopped counting when it ended');
  assert.equal(c.endedAt, T0 + 12_000);
  assert.ok(clockHolds(c), 'no turn of the agent starts again');
  assert.ok(PUBLIC_EVENT_TYPES.includes('clock.ended'));
});

test('#1749 the person’s stop ends a running clock: the turn stops, what it’s sent waits, and resume is refused', async () => {
  const { rt, store, adapter, t, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 600 });
  const turn = slowToExit();
  adapter.next.push(turn);
  rt.sendMessage(t.id, { text: 'Work until stopped.' });
  await sleep(5_000);
  const { clock } = clockAction(rt, se.id, { action: 'stop' });
  assert.equal(clock.state, 'ended');
  await sleep(1);
  assert.equal(turn.reason?.name, 'AbortError', 'the stop stopped the turn');
  turn.exit();
  await sleep(10);
  rt.sendMessage(t.id, { text: 'Sent after the end.' });
  await sleep(10);
  assert.equal(adapter.calls.length, 1, 'no turn after the end');
  assert.deepEqual(
    waitingEntries(rt, se.id).map((e) => store.item(t.id, e.itemId)?.text),
    ['Sent after the end.'],
  );
  assert.throws(() => clockAction(rt, se.id, { action: 'resume' }), { status: 409 });
  assert.throws(() => clockAction(rt, se.id, { action: 'stop' }), { status: 409 }, 'a second stop');
  assert.throws(() => clockAction(rt, se.id, { action: 'pause' }), { status: 409 });
  assert.equal(adapter.calls.length, 1);
  assert.match(
    clockLines(store, t).find((i) => i.change === 'ended')?.text ?? '',
    /^@\w+’s run clock ended at 5s of 600s, because you stopped it, so Postbox stopped @\w+’s turn/,
  );
});

test('#1749 a paused clock can be ended too, and a restart keeps it ended with its one line', () => {
  const { rt, store, t, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  clockAction(rt, se.id, { action: 'pause' }, at(10_000));
  clockAction(rt, se.id, { action: 'stop' }, at(30_000));
  assert.equal(store.state.clocks[se.id].state, 'ended');
  assert.equal(store.state.clocks[se.id].usedMs, 10_000, 'the paused time isn’t counted');
  assert.match(clockLines(store, t).at(-1)?.text ?? '', /run clock ended at 10s of 60s, because you stopped it\. Messages to @\w+ here now wait/);
  const lines = clockLines(store, t).length;
  rearmClocks(rt, at(90_000));
  assert.equal(store.state.clocks[se.id].state, 'ended', 'not expired at its budget after the end');
  assert.equal(clockLines(store, t).length, lines, 'no second line, and no restored line');
  assert.equal(store.since(0).filter((e) => e.type === 'clock.expired').length, 0);
});

test('#1749 a stop with no clock is refused, and the refusal of an unknown action names stop', () => {
  const { rt, se } = setup();
  assert.throws(() => clockAction(rt, se.id, { action: 'stop' }), { status: 409 });
  assert.throws(() => clockAction(rt, se.id, { action: 'end' }), { status: 422, message: 'A run clock’s action is start, pause, resume or stop.' });
});

test('#1749 the end drops the turns a pause held in memory, and holds no new one', () => {
  const { rt, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  clockAction(rt, se.id, { action: 'pause' }, at(10_000));
  const turn = { message: { text: 'Held while paused.' }, summarizeTo: null, threadId: null };
  holdForClock(rt, se.id, turn);
  assert.equal(heldCount(rt, se.id), 1);
  clockAction(rt, se.id, { action: 'stop' }, at(20_000));
  assert.equal(heldCount(rt, se.id), 0, 'none of them can run');
  holdForClock(rt, se.id, turn);
  assert.equal(heldCount(rt, se.id), 0, 'and none is kept after the end');
});

test('#1749 an end whose line a kill lost gets it back as Postbox starts', () => {
  const { rt, store, t, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  store.emit('clock.ended', { sessionId: se.id, elapsedMs: 15_000, budgetMs: 60_000, at: T0 + 15_000 });
  rearmClocks(rt, at(20_000));
  assert.deepEqual(
    clockLines(store, t).map((i) => i.change),
    ['started', 'ended'],
  );
  assert.match(clockLines(store, t).at(-1).text, /run clock ended at 15s of 60s, because you stopped it\./);
});

test('#1749 a forced stop after the end voids the run and keeps it ended, at its time used', () => {
  const s = emptyState();
  apply(s, 'clock.started', { sessionId: 'se_1', threadId: 'th_1', budgetMs: 60_000, at: T0 });
  apply(s, 'clock.ended', { sessionId: 'se_1', elapsedMs: 12_000, budgetMs: 60_000, stopping: ['turn:tu_1'], at: T0 + 12_000 });
  apply(s, 'clock.stopped', { sessionId: 'se_1', turn: 'turn:tu_1', forced: true, why: 'watchdog', at: T0 + 30_000 });
  const c = s.clocks.se_1;
  assert.deepEqual([c.state, c.usedMs, c.endedAt], ['ended', 12_000, T0 + 12_000]);
  assert.deepEqual(c.voided, { why: 'watchdog', at: T0 + 30_000 });
});

test('#1749 a host turn attached after the end stops as the person’s stop, not as the budget', async () => {
  const { rt, store, adapter, t, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 600 });
  const turn = slowToExit();
  adapter.next.push(turn);
  rt.sendMessage(t.id, { text: 'Work on.' });
  await sleep(5);
  // The end as a restart finds it, with the turn still running here.
  store.emit('clock.ended', { sessionId: se.id, elapsedMs: 5, budgetMs: 600_000, at: Date.now() });
  const running = rt.turns.get(se.id);
  stopHeldTurn(rt, running);
  assert.equal(running.stopReason, 'stop');
  turn.exit();
  await sleep(10);
});

test('#1749 Retry after the end is refused with words that say the run was stopped, not that it ran out', async () => {
  const { rt, store, t, se, adapter } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 600 });
  adapter.next.push(async () => {
    throw new Error('The backend fell over.');
  });
  rt.sendMessage(t.id, { text: 'Try this.' });
  await sleep(1);
  clockAction(rt, se.id, { action: 'stop' });
  const failed = store.items(t.id).findLast((i) => i.kind === 'agent');
  assert.throws(
    () => rt.retry(t.id, failed.id),
    (e) => e.status === 409 && /run clock was stopped, so no turn of @\w+ starts in this conversation again/.test(e.message),
  );
  assert.equal(adapter.calls.length, 1, 'no turn');
});

test('#1749 an end that comes after the expiry changes nothing: only a run still going can end', () => {
  const s = emptyState();
  apply(s, 'clock.started', { sessionId: 'se_1', threadId: 'th_1', budgetMs: 60_000, at: T0 });
  apply(s, 'clock.expired', { sessionId: 'se_1', elapsedMs: 60_000, budgetMs: 60_000, at: T0 + 60_000 });
  apply(s, 'clock.ended', { sessionId: 'se_1', elapsedMs: 70_000, budgetMs: 60_000, at: T0 + 70_000 });
  assert.deepEqual([s.clocks.se_1.state, s.clocks.se_1.usedMs], ['expired', 60_000]);
});
