// An agent’s run clock (shared/run-clock.mjs, server/run-clock.mjs): the store keeps its budget and what it used, each
// turn of a clocked agent carries its line and records clock.turn, and at its budget Postbox records clock.expired,
// stops the running turn and starts no other. No real timer runs: node:test’s mock timers stand in for setTimeout,
// setInterval and Date in every test, and time moves only when a test ticks it. The turns are the Stop tests’ scripted
// adapter, whose steps settle on the event loop’s turns (setImmediate), not on time.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { formatMessage } from '../server/adapters/guide.mjs';
import { armClock, clockAction, rearmClocks } from '../server/run-clock.mjs';
import { clockElapsed, clockLine } from '../shared/run-clock.mjs';
import { apply, emptyState, PUBLIC_EVENT_TYPES } from '../shared/state.mjs';
import { waitingEntries } from './arrange.mjs';
import { setup, slowToExit } from './stop-fixture.mjs';

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
const clockEvents = (store) => store.since(0).filter((e) => e.type.startsWith('clock.'));

test('the store counts a clock’s running time and leaves out the time the person paused it', () => {
  const s = emptyState();
  apply(s, 'clock.started', { sessionId: 'se_1', threadId: 'th_1', budgetMs: 60_000, at: T0 });
  apply(s, 'clock.paused', { sessionId: 'se_1', at: T0 + 10_000 });
  assert.equal(clockElapsed(s.clocks.se_1, T0 + 40_000), 10_000);
  apply(s, 'clock.resumed', { sessionId: 'se_1', at: T0 + 40_000 });
  assert.equal(clockElapsed(s.clocks.se_1, T0 + 45_000), 15_000);
  // Never past the budget, however late it’s read.
  assert.equal(clockElapsed(s.clocks.se_1, T0 + 999_000), 60_000);
  apply(s, 'clock.expired', { sessionId: 'se_1', at: T0 + 90_000 });
  assert.deepEqual(
    { ...s.clocks.se_1 },
    {
      sessionId: 'se_1',
      threadId: 'th_1',
      budgetMs: 60_000,
      usedMs: 60_000,
      since: null,
      state: 'expired',
      startedAt: T0,
      expiredAt: T0 + 90_000,
    },
  );
});

test('every clock event reaches /api/stream, as a public event type', () => {
  for (const type of ['clock.started', 'clock.paused', 'clock.resumed', 'clock.turn', 'clock.expired']) assert.ok(PUBLIC_EVENT_TYPES.includes(type), type);
});

test('the clock’s line is the last thing a turn’s message says, in whole seconds of elapsed and budget', () => {
  const clock = { budgetMs: 60_000, usedMs: 0, since: T0 };
  const line = clockLine(clock, T0 + 12_900);
  assert.equal(line, '[Postbox] Run clock: elapsed 12s / budget 60s. At the budget, Postbox stops your turn and starts no other.');
  const said = formatMessage({ kind: 'user', text: 'Go on.', facts: 'Facts.', context: ['Background.'], clock: line });
  assert.ok(said.endsWith(`\n\n${line}`), said);
  const input = formatMessage({ kind: 'input', text: 'Entries.', facts: 'Facts.', clock: line });
  assert.ok(input.endsWith(`\n\n${line}`), input);
  // An agent with no clock is told nothing of one.
  assert.doesNotMatch(formatMessage({ kind: 'user', text: 'Go on.' }), /Run clock/);
});

test('each turn of a clocked agent carries its elapsed time, which goes up, and the stream records it', async () => {
  const { rt, store, adapter, t, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, () => Date.now() - 5_000);
  rt.sendMessage(t.id, { text: 'first' });
  await sleep(10);
  // Started 5 s ago here, so the second turn reads at least 25 s: the first one’s clock moved 20 s back.
  store.state.clocks[se.id].since -= 20_000;
  rt.sendMessage(t.id, { text: 'second' });
  await sleep(10);
  const lines = adapter.calls.map((c) => c.message.clock);
  assert.match(lines[0], /^\[Postbox\] Run clock: elapsed [5-6]s \/ budget 60s\. /);
  assert.match(lines[1], /^\[Postbox\] Run clock: elapsed 2[5-6]s \/ budget 60s\. /);
  const turns = clockEvents(store).filter((e) => e.type === 'clock.turn');
  assert.equal(turns.length, 2);
  assert.ok(turns[1].data.elapsedMs > turns[0].data.elapsedMs);
  assert.equal(turns[0].data.budgetMs, 60_000);
  assert.equal(typeof turns[0].data.turnId, 'string');
});

test('an agent with no clock gets no line and no clock event', async () => {
  const { rt, store, adapter, t } = setup();
  rt.sendMessage(t.id, { text: 'hello' });
  await sleep(10);
  assert.equal(adapter.calls[0].message.clock, undefined);
  assert.deepEqual(clockEvents(store), []);
});

test('at its budget the clock expires, the running turn stops, and no new turn starts', async () => {
  const { rt, store, adapter, t, se } = setup();
  // Date is the mock clock’s, so the clock and its timer read the same time.
  const now = Date.now();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 });
  const turn = slowToExit();
  adapter.next.push(turn);
  rt.sendMessage(t.id, { text: 'Work until stopped.' });
  await sleep(5);
  assert.ok(rt.turns.has(se.id));
  // The clock’s own timer fires as the mock clock passes 60 s.
  await sleep(59_000);
  assert.equal(store.state.clocks[se.id].state, 'running', 'not before its budget');
  await sleep(1_000);
  assert.equal(store.state.clocks[se.id].state, 'expired');
  assert.equal(turn.reason?.name, 'AbortError');
  const reply = store.items(t.id).findLast((i) => i.kind === 'agent');
  assert.equal(reply.status, 'stopped');
  turn.exit();
  await sleep(10);
  rt.sendMessage(t.id, { text: 'One more thing.' });
  await sleep(10);
  assert.equal(adapter.calls.length, 1, 'no turn after the clock expired');
  assert.equal(rt.turns.has(se.id), false);
  const expired = clockEvents(store).filter((e) => e.type === 'clock.expired');
  assert.equal(expired.length, 1);
  // The mock clock reads the end of the tick that fired it: 60 s, plus the 5 ms the turn took to start.
  const late = expired[0].data.at - now;
  assert.ok(late >= 60_000 && late <= 60_005, String(late));
});

test('a clock that ran out while Postbox was down expires as it starts', () => {
  const { rt, store, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  rearmClocks(rt, at(30_000));
  assert.equal(store.state.clocks[se.id].state, 'running');
  rearmClocks(rt, at(60_000));
  assert.equal(store.state.clocks[se.id].state, 'expired');
});

test('the person’s clock actions refuse a bad budget, a second start and a pause of nothing, and change nothing', () => {
  const { rt, store, se } = setup();
  for (const budgetS of [0, -1, 1.5, '60', 30 * 86_400 + 1])
    assert.throws(() => clockAction(rt, se.id, { action: 'start', budgetS }, at(0)), { status: 422 }, String(budgetS));
  assert.throws(() => clockAction(rt, se.id, { action: 'pause' }, at(0)), { status: 409 });
  assert.throws(() => clockAction(rt, se.id, { action: 'reset' }, at(0)), { status: 422 });
  assert.deepEqual(clockEvents(store), []);
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  assert.throws(() => clockAction(rt, se.id, { action: 'start', budgetS: 600 }, at(1_000)), { status: 409 });
  assert.equal(store.state.clocks[se.id].budgetMs, 60_000);
  assert.throws(() => clockAction(rt, se.id, { action: 'resume' }, at(1_000)), { status: 409 });
  clockAction(rt, se.id, { action: 'pause' }, at(10_000));
  // Paused: the timer is cleared, so a check long after doesn’t expire it.
  armClock(rt, se.id, at(500_000));
  assert.equal(store.state.clocks[se.id].state, 'paused');
  assert.throws(() => clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(1_000)), { status: 409 });
});

test('a pause stops the running turn, what the agent is sent meanwhile waits in its inbox, and the resume starts it', async () => {
  const { rt, store, adapter, t, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 600 });
  const turn = slowToExit();
  adapter.next.push(turn);
  rt.sendMessage(t.id, { text: 'Work until paused.' });
  await sleep(5);
  clockAction(rt, se.id, { action: 'pause' });
  await sleep(1);
  assert.equal(turn.reason?.name, 'AbortError', 'the pause stopped the turn');
  turn.exit();
  await sleep(10);
  rt.sendMessage(t.id, { text: 'Sent while paused.' });
  await sleep(10);
  assert.equal(adapter.calls.length, 1, 'no turn while paused');
  assert.deepEqual(
    waitingEntries(rt, se.id).map((e) => store.item(t.id, e.itemId)?.text),
    ['Sent while paused.'],
  );
  clockAction(rt, se.id, { action: 'resume' });
  await sleep(10);
  assert.equal(adapter.calls.length, 2);
  assert.match(JSON.stringify(adapter.calls[1].message), /Sent while paused\./);
  assert.match(adapter.calls[1].message.clock, /^\[Postbox\] Run clock: elapsed 0s \/ budget 600s\. /);
});

test('a message sent after the clock expired stays waiting in the inbox, never taken by a turn that didn’t run', async () => {
  const { rt, store, adapter, t, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  rearmClocks(rt, at(61_000));
  rt.sendMessage(t.id, { text: 'Too late.' });
  await sleep(10);
  assert.equal(adapter.calls.length, 0);
  const inbox = store.state.inbox[se.id] ?? [];
  assert.deepEqual(
    inbox.map((e) => e.state),
    ['waiting'],
  );
});

test('as Postbox starts again, each running clock marks where its record resumes, with its elapsed time', () => {
  const { rt, store, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  rearmClocks(rt, at(20_000));
  const restored = clockEvents(store).filter((e) => e.type === 'clock.restored');
  assert.deepEqual(
    restored.map((e) => e.data),
    [{ sessionId: se.id, elapsedMs: 20_000, budgetMs: 60_000, at: T0 + 20_000 }],
  );
  clockAction(rt, se.id, { action: 'pause' }, at(21_000));
  rearmClocks(rt, at(30_000));
  assert.equal(clockEvents(store).filter((e) => e.type === 'clock.restored').length, 1, 'a paused clock marks nothing');
});

test('an agent gets one clock per conversation, so a second timed run can’t start with the first in its context', () => {
  const { rt, store, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  rearmClocks(rt, at(61_000));
  assert.throws(() => clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(70_000)), { status: 409 });
  assert.equal(store.state.clocks[se.id].state, 'expired', 'the second clock didn’t start');
  assert.equal(clockEvents(store).filter((e) => e.type === 'clock.started').length, 1);
});

test('a clock doesn’t start over messages already waiting in the agent’s inbox', async () => {
  const { rt, store, adapter, t, se } = setup();
  const turn = slowToExit();
  adapter.next.push(turn);
  rt.sendMessage(t.id, { text: 'Work on this.' });
  await sleep(5);
  rt.sendMessage(t.id, { text: 'From before the run, waiting while the agent is busy.' });
  await sleep(5);
  assert.ok(waitingEntries(rt, se.id).length > 0);
  assert.throws(() => clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0)), { status: 409 });
  assert.equal(store.state.clocks[se.id], undefined);
  rt.stop(se.id);
  turn.exit();
  await sleep(10);
});

test('a clock doesn’t start while the agent is working, even with nothing waiting', async () => {
  const { rt, store, adapter, t, se } = setup();
  const turn = slowToExit();
  adapter.next.push(turn);
  rt.sendMessage(t.id, { text: 'Work on this.' });
  await sleep(5);
  assert.deepEqual(waitingEntries(rt, se.id), []);
  assert.throws(() => clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0)), { status: 409 });
  // Stopped but still exiting counts as working too.
  rt.stop(se.id);
  assert.throws(() => clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0)), { status: 409 });
  assert.equal(store.state.clocks[se.id], undefined);
  turn.exit();
  await sleep(10);
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  assert.equal(store.state.clocks[se.id].state, 'running');
});

test('each change of the clock is a line in the agent’s conversation, and the expiry’s says messages now wait', () => {
  const { rt, store, t, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  clockAction(rt, se.id, { action: 'pause' }, at(10_000));
  clockAction(rt, se.id, { action: 'resume' }, at(20_000));
  armClock(rt, se.id, at(90_000));
  const lines = store.items(t.id).filter((i) => i.kind === 'system' && i.variant === 'clock');
  assert.deepEqual(
    lines.map((i) => i.change),
    ['started', 'paused', 'resumed', 'expired'],
  );
  assert.equal(lines[2].text, '@developer’s run clock resumed at 10s of 60s.');
  assert.match(lines[3].text, /Messages to @developer here now wait, and no turn starts; a new timed run goes in a new conversation\.$/);
});
