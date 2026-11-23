// What the conversation shows of an agent’s run clock (server/run-clock-notes.mjs): a line at each change, and the line
// a holding clock gets back as Postbox starts if a kill lost it. No real timer runs: node:test’s mock timers stand in
// for setTimeout, setInterval and Date, and time is injected (`at`).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { armClock, clockAction, rearmClocks } from '../server/run-clock.mjs';
import { clocked as setup } from './run-clock-fixture.mjs';
import { slowToExit } from './stop-fixture.mjs';

const T0 = 1_800_000_000_000;
beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 }));
afterEach(() => mock.timers.reset());
const at = (ms) => () => T0 + ms;

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

test('a clock that holds its agent gets its line as Postbox starts, when a kill came between its event and its line', () => {
  const { rt, store, t, se } = setup();
  const lines = () =>
    store
      .items(t.id)
      .filter((i) => i.variant === 'clock')
      .map((i) => i.change);
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  // The kill: the pause is recorded, and its line never is.
  store.emit('clock.paused', { sessionId: se.id, at: T0 + 10_000 });
  assert.deepEqual(lines(), ['started']);
  rearmClocks(rt, at(20_000));
  assert.deepEqual(lines(), ['started', 'paused']);
  rearmClocks(rt, at(30_000));
  assert.deepEqual(lines(), ['started', 'paused'], 'a second start adds nothing');
  // The same for an expiry whose line was lost.
  store.emit('clock.resumed', { sessionId: se.id, at: T0 + 30_000 });
  store.emit('clock.expired', { sessionId: se.id, elapsedMs: 60_000, budgetMs: 60_000, at: T0 + 80_000 });
  rearmClocks(rt, at(90_000));
  assert.deepEqual(lines(), ['started', 'paused', 'expired']);
  assert.match(store.items(t.id).findLast((i) => i.variant === 'clock').text, /Messages to @developer here now wait/);
});

test('the line a restart gives back to an expiry whose host turn isn’t confirmed stopped says Postbox asked the host, not that it stopped it', () => {
  const { rt, store, t, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  // The kill came between the expiry, which listed a host turn still to stop, and its line.
  store.emit('clock.expired', { sessionId: se.id, elapsedMs: 60_000, budgetMs: 60_000, stopping: ['host-turn-1'], at: T0 + 60_000 });
  rearmClocks(rt, at(70_000));
  const text = store.items(t.id).findLast((i) => i.variant === 'clock').text;
  assert.match(text, /so Postbox asked @developer’s host to stop @developer, which may still be working there until the host confirms\./);
  assert.doesNotMatch(text, /Postbox stopped @developer/);
});

/** Lets the scripted turns settle, then moves the mock clock on by `ms`, and lets what that fires settle. */
async function sleep(ms) {
  const turns = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  await turns();
  mock.timers.tick(ms);
  await turns();
}
const changes = (store, t) =>
  store
    .items(t.id)
    .filter((i) => i.variant === 'clock')
    .map((i) => i.change);

test('a restart adds no second expiry line when the clock expired during a turn whose end came last', async () => {
  const { rt, store, adapter, t, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 });
  const turn = slowToExit();
  adapter.next.push(turn);
  rt.sendMessage(t.id, { text: 'Work until stopped.' });
  await sleep(60_000);
  turn.exit();
  await sleep(10);
  assert.deepEqual(changes(store, t), ['started', 'expired', 'stopped']);
  rearmClocks(rt);
  rearmClocks(rt);
  assert.deepEqual(changes(store, t), ['started', 'expired', 'stopped']);
});

test('a restart adds no second pause line when the paused turn’s end came last', async () => {
  const { rt, store, adapter, t, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 600 });
  const turn = slowToExit();
  adapter.next.push(turn);
  rt.sendMessage(t.id, { text: 'Work until paused.' });
  await sleep(5);
  clockAction(rt, se.id, { action: 'pause' });
  turn.exit();
  await sleep(10);
  assert.deepEqual(changes(store, t), ['started', 'paused', 'stopped']);
  rearmClocks(rt);
  assert.deepEqual(changes(store, t), ['started', 'paused', 'stopped']);
});

test('a lost pause line comes back after an earlier pause and resume, which had theirs', () => {
  const { rt, store, t, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 }, at(0));
  clockAction(rt, se.id, { action: 'pause' }, at(10_000));
  clockAction(rt, se.id, { action: 'resume' }, at(20_000));
  store.emit('clock.paused', { sessionId: se.id, at: T0 + 30_000 });
  rearmClocks(rt, at(40_000));
  assert.deepEqual(changes(store, t), ['started', 'paused', 'resumed', 'paused']);
});
