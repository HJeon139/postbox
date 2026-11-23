// #1713: a turn that failed for its provider (529 Overloaded, or another status its adapter marks as one that passes)
// goes again on its own, after a wait that grows, at most three times in a row. While it waits its row says it’s
// retrying and nothing needs the person; once the tries run out, the agents whose messages it took hear so in the
// room, and still nothing needs the person. The waits are the test’s own clock (config.retryAfter), so nothing sleeps
// for them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withTransient } from '../server/harness-failure.mjs';
import { fireScheduledWake } from '../server/scheduled-wakes.mjs';
import { armAutoRetries } from '../server/turn-transient.mjs';
import { agentState } from '../shared/agent-state.mjs';
import { TRANSIENT_RETRY } from '../shared/limits.mjs';
import { needsYouNow } from '../shared/needs.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

// A failure already marked by its adapter; tests/claude-code-transient.test.mjs reads it from a result’s status.
const overloaded = () => async () => {
  throw withTransient(new Error('API Error: 529 Overloaded'), 529);
};

/** The runtime of setup(), with the waits it starts held for the test to end, and the notifications it raises. */
function room() {
  const f = setup();
  /** @type {{ ms: number, fn: () => void }[]} */
  const waits = [];
  f.rt.config.retryAfter = (/** @type {number} */ ms, /** @type {() => void} */ fn) => waits.push({ ms, fn });
  /** @type {any[]} */
  const heard = [];
  f.store.subscribe((/** @type {any} */ ev) => ev.type === 'notify' && heard.push(ev.data));
  const blocking = () => heard.filter((n) => n.level === 'blocking');
  /** Ends the next wait, as its timer would, and lets the turn it starts finish. */
  const endWait = async () => {
    const w = waits.shift();
    assert.ok(w, 'a wait was started');
    w.fn();
    await settle(f.rt);
  };
  return { ...f, waits, blocking, endWait };
}
const repliesOf = (/** @type {any} */ f) => f.store.items(f.t.id).filter((/** @type {any} */ i) => i.kind === 'agent' && i.sessionId === f.beta.id);
const seconds = (/** @type {number} */ ms) => Math.round(ms / 1000);

test('#1713 a turn its provider overloaded waits to go again on its own, says so in its row, and alarms nobody', async () => {
  const f = room();
  f.adapter.next.push(overloaded());
  f.rt.sendMessage(f.t.id, { text: '@beta go' });
  await settle(f.rt);
  const se = f.store.state.sessions[f.beta.id];
  assert.deepEqual(f.blocking(), [], 'nothing blocking: the person could do no more than Retry');
  assert.equal(needsYouNow(se), false);
  assert.equal(agentState(se, f.store.state).state, 'retrying', 'its row says it’s retrying');
  assert.equal(agentState(se, f.store.state).until, se.autoRetry.at);
  const [failed] = repliesOf(f);
  assert.equal(failed.status, 'failed', 'its reply keeps Retry meanwhile');
  assert.equal(failed.transient.status, 529);
  assert.equal(failed.note, 'The provider was overloaded (529), so Postbox will try again in 30 s.');
  assert.deepEqual(
    f.waits.map((w) => seconds(w.ms)),
    [30],
  );
  assert.equal(f.adapter.calls.length, 1, 'nothing goes before the wait ends');
});

test('#1713 at the end of the wait the turn goes again, and a turn that goes well ends the count', async () => {
  const f = room();
  f.adapter.next.push(overloaded());
  f.rt.sendMessage(f.t.id, { text: '@beta go' });
  await settle(f.rt);
  await f.endWait();
  assert.equal(f.adapter.calls.length, 2, 'the retry ran');
  assert.deepEqual(
    f.store.state.inbox[f.beta.id].map((e) => [e.state, e.resend]),
    [['delivered', true]],
    'it took what the failed turn took, as the person’s Retry does',
  );
  const [failed, answer] = repliesOf(f);
  assert.equal(failed.status, 'retried');
  assert.equal(answer.text, 'ok');
  const se = f.store.state.sessions[f.beta.id];
  assert.equal(se.autoRetry ?? null, null, 'the count starts again at the next failure');
  assert.equal(agentState(se, f.store.state).state, 'idle');
});

test('#1713 three tries in a row run out: the person is told, as of any failed turn, and the agent that waited hears it', async () => {
  const f = room();
  f.adapter.next.push(overloaded(), overloaded(), overloaded(), overloaded());
  f.rt.delivery.send({ sessionId: f.beta.id, threadId: f.t.id, source: 'mention', text: '@beta check the dates', from: 'alpha' });
  await settle(f.rt);
  const waited = [];
  for (let i = 0; i < TRANSIENT_RETRY.delaysMs.length; i++) {
    waited.push(seconds(f.waits[0].ms));
    await f.endWait();
  }
  assert.deepEqual(waited, [30, 120, 480], 'each wait longer than the last');
  assert.equal(f.adapter.calls.filter((c) => c.handle === 'beta').length, 4, 'the turn and its three tries');
  assert.deepEqual(f.waits, [], 'no fourth try');
  const se = f.store.state.sessions[f.beta.id];
  assert.equal(se.state, 'failed');
  // The owner’s decision on #1713: once Postbox stops trying, the agent would stay failed with nothing to start
  // it again, so the person is told, as of any failed turn.
  assert.equal(needsYouNow(se), true, 'it needs the person, who alone can start it again');
  assert.equal(f.blocking().length, 1, 'one blocking notice, at the run-out only');
  assert.equal(se.autoRetry ?? null, null);
  assert.equal(agentState(se, f.store.state).state, 'failed', 'its row says failed, as any failed turn’s, no longer retrying');
  const last = repliesOf(f).at(-1);
  assert.match(last.note, /overloaded \(529\) on 4 tries in a row, so Postbox stopped trying/);
  assert.equal(last.transient, undefined, 'its callout is an alert again, as any failure’s');
  for (const r of repliesOf(f).slice(0, -1)) assert.equal(r.transient?.at ?? null, null, 'no earlier reply still says it will try again');

  const line = f.store.items(f.t.id).find((i) => i.kind === 'system' && i.variant === 'retries-out');
  assert.ok(line, 'one line in the room says so');
  assert.match(line.text, /^@alpha: @beta’s turn failed 4 times in a row because its provider was overloaded \(529\)/);
  assert.match(line.text, /send the work to another agent/);
  const told = f.store.state.inbox[f.alpha.id].filter((e) => e.itemId === line.id);
  assert.equal(told.length, 1, '@alpha, whose message the turn took, is sent it');
  assert.equal(f.adapter.calls.at(-1).handle, 'alpha', 'and woken by it, to send the work elsewhere');
  assert.equal(
    f.store.state.inbox[f.beta.id].some((e) => e.itemId === line.id),
    false,
    'not the agent that failed',
  );
});

test('#1713 the person’s own Retry before the wait ends takes it over: the wait then starts nothing', async () => {
  const f = room();
  f.adapter.next.push(overloaded());
  f.rt.sendMessage(f.t.id, { text: '@beta go' });
  await settle(f.rt);
  await f.rt.retry(f.t.id, repliesOf(f)[0].id);
  await settle(f.rt);
  assert.equal(f.adapter.calls.length, 2);
  await f.endWait();
  assert.equal(f.adapter.calls.length, 2, 'the turn went once more, not twice');
});

test('#1713 a restart starts the wait again for what was left of it, so the reply’s note stays true', async () => {
  const f = room();
  f.adapter.next.push(overloaded());
  f.rt.sendMessage(f.t.id, { text: '@beta go' });
  await settle(f.rt);
  f.waits.length = 0;
  armAutoRetries(f.rt);
  assert.equal(f.waits.length, 1);
  assert.ok(f.waits[0].ms <= 30_000 && f.waits[0].ms > 25_000);
  await f.endWait();
  assert.equal(f.adapter.calls.length, 2);
});

test('#1713 a scheduled wake’s turn its provider failed isn’t retried on its own, and its schedule is as on main', async () => {
  // #1713: re-arming the schedule for a provider’s failure raised an alarm at each of its
  // attempts. A scheduled wake is left as it was: it fails once, and isn’t sent again here either.
  const f = room();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Check the run.' });
  f.adapter.next.push(overloaded());
  clearTimeout(f.rt.timers.get(sc.id));
  fireScheduledWake(f.rt, sc);
  await settle(f.rt);
  assert.equal(f.store.state.schedules[sc.id], undefined, 'its schedule is done, as on main');
  assert.deepEqual(f.waits, [], 'no retry of its own');
});
