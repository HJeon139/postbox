// An agent’s run clock (shared/run-clock.mjs, server/run-clock.mjs): the store keeps its budget and what it used, each
// turn of a clocked agent carries its line and records clock.turn, and at its budget Postbox records clock.expired,
// stops the running turn and starts no other. Time is injected (`now`); the turns are the Stop tests’ scripted adapter.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessage } from '../server/adapters/guide.mjs';
import { armClock, clockAction, rearmClocks } from '../server/run-clock.mjs';
import { clockElapsed, clockLine } from '../shared/run-clock.mjs';
import { apply, emptyState, PUBLIC_EVENT_TYPES } from '../shared/state.mjs';
import { waitingEntries } from './arrange.mjs';
import { setup, slowToExit } from './stop-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = 1_800_000_000_000;
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
  const now = Date.now();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, () => now);
  const turn = slowToExit();
  adapter.next.push(turn);
  rt.sendMessage(t.id, { text: 'Work until stopped.' });
  await sleep(5);
  assert.ok(rt.turns.has(se.id));
  // The timer’s check, 61 s on.
  armClock(rt, se.id, () => now + 61_000);
  assert.equal(store.state.clocks[se.id].state, 'expired');
  await sleep(1);
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
  assert.equal(expired[0].data.at, now + 61_000);
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
