// #874: a turn for an agent whose backend isn’t registered in this Postbox (POSTBOX_BACKENDS=mock, --demo, a missing
// SDK, or a name this version doesn’t know) fails with a reason and Retry, wherever it comes from, instead of
// throwing; a message you send to one is refused before it’s posted.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { notHere } from '../server/remote/placement.mjs';
import { reattach } from '../server/remote/turns-resume.mjs';
import { Runtime } from '../server/runtime.mjs';
import { fireScheduledWake } from '../server/scheduled-wakes.mjs';
import { restarted, rig, startUp, until } from './remote-turns-helpers.mjs';
import { ScriptedAdapter, settle, setup } from './side-threads-fixture.mjs';

const REASON = '@beta’s turn didn’t start: Claude Code isn’t available on this computer. Install it and restart Postbox, or change this agent’s backend.';

/** Its persona runs on a backend this Postbox didn’t register (createPersona refuses one, so it’s emitted). */
const unregister = (f, p, backend = 'claude-code') => f.store.emit('persona', { ...f.rt.persona(p.id), backend });
const failedIn = (f, threadId) => f.store.items(threadId).filter((i) => i.kind === 'agent' && i.status === 'failed');
const wakeLines = (f, threadId) => f.store.items(threadId).filter((i) => i.kind === 'system' && i.variant === 'wake');
/** A message of yours for @beta, waiting in the queue as it does when Postbox stops. */
function queued(f, text = 'hello') {
  const th = f.store.state.threads[f.t.id];
  f.rt.putThread({ ...th, queue: [{ id: 'q_1', text, attachments: [], sessionIds: [f.beta.id], at: Date.now() }] });
}
/** @beta’s failed reply from a queued message the drain sent. */
async function failedOnce() {
  const f = setup();
  unregister(f, f.b);
  queued(f);
  f.rt.drainAll();
  await settle(f.rt);
  return f;
}

test('#874 a queued message for an agent whose backend isn’t registered gets a failed reply with Retry at the drain', async () => {
  const f = setup();
  unregister(f, f.b);
  queued(f);
  assert.doesNotThrow(() => f.rt.drainAll());
  await settle(f.rt);
  const failed = failedIn(f, f.t.id);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].error, REASON);
  assert.equal(failed[0].asked.message.text, 'hello');
  assert.equal(f.store.state.sessions[f.beta.id].state, 'failed');
  assert.deepEqual(f.store.state.threads[f.t.id].queue, []);
  assert.equal(f.adapter.calls.length, 0, 'no adapter was asked');
});

test('#874 a due wake for an agent whose backend isn’t registered fails its turn and its schedule ends done', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.beta.id, { inMs: 60_000, note: 'Check the run.' });
  unregister(f, f.b);
  clearTimeout(f.rt.timers.get(sc.id));
  assert.doesNotThrow(() => fireScheduledWake(f.rt, sc));
  await settle(f.rt);
  assert.equal(failedIn(f, sc.threadId)[0]?.error, REASON);
  assert.equal(f.store.state.schedules[sc.id], undefined, 'not re-armed as a network failure would be');
  assert.equal(f.store.item(sc.threadId, sc.itemId).status, 'done');
  assert.equal(f.rt.timers.has(sc.id), false);
  assert.equal(wakeLines(f, sc.threadId).length, 1);
});

test('#874 after a wake failed for an unregistered backend, the next start neither crashes nor adds a line', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.beta.id, { inMs: 60_000, note: 'Check the run.' });
  unregister(f, f.b);
  clearTimeout(f.rt.timers.get(sc.id));
  fireScheduledWake(f.rt, sc);
  await settle(f.rt);
  const after = new ScriptedAdapter();
  const rt2 = new Runtime({ store: f.store, adapters: new AdapterRegistry().register(after), corpus: f.rt.corpus, config: f.rt.config });
  assert.doesNotThrow(() => {
    rt2.rearmSchedules();
    rt2.drainAll();
  });
  await settle(rt2);
  assert.equal(rt2.timers.size, 0, 'nothing armed');
  assert.equal(wakeLines(f, sc.threadId).length, 1);
  assert.equal(failedIn(f, sc.threadId).length, 1);
  assert.equal(after.calls.length, 0);
});

test('#874 a message to an agent whose backend isn’t registered is refused before it’s posted', () => {
  const f = setup();
  unregister(f, f.b);
  const before = f.store.items(f.t.id).length;
  const { hops, members } = f.store.state.threads[f.t.id];
  assert.throws(() => f.rt.sendMessage(f.t.id, { text: '@beta hi' }), { status: 422, message: REASON });
  // One of two mentioned: refused for both, since the message is one.
  assert.throws(() => f.rt.sendMessage(f.t.id, { text: '@alpha @beta hi' }), { status: 422, message: REASON });
  // With no mention, @beta is the last speaker it would go to.
  f.rt.putThread({ ...f.store.state.threads[f.t.id], lastSpeaker: f.beta.id });
  assert.throws(() => f.rt.sendMessage(f.t.id, { text: 'hi' }), { status: 422, message: REASON });
  assert.equal(f.store.items(f.t.id).length, before, 'nothing posted');
  assert.equal(f.store.state.threads[f.t.id].hops, hops);
  assert.deepEqual(f.store.state.threads[f.t.id].members, members);
  assert.deepEqual(f.store.state.threads[f.t.id].queue ?? [], []);
  assert.equal(f.adapter.calls.length, 0);
});

test('#874 a mention of an agent not yet in the conversation, whose backend isn’t registered, doesn’t join it', () => {
  const f = setup();
  unregister(f, f.c);
  const members = f.store.state.threads[f.t.id].members;
  assert.throws(() => f.rt.sendMessage(f.t.id, { text: '@gamma hi' }), { status: 422, message: REASON.replace('@beta', '@gamma') });
  assert.deepEqual(f.store.state.threads[f.t.id].members, members);
  assert.equal(
    Object.values(f.store.state.sessions).some((x) => x.personaId === f.c.id),
    false,
  );
});

test('#874 a topic-thread message with no mention, for an agent not in the conversation whose backend isn’t registered, joins it to nothing', async () => {
  const f = setup();
  f.rt.sendMessage(f.t.id, { text: '@beta hi' });
  await settle(f.rt);
  const { threadId } = f.rt.startTopic(f.t.id, f.store.items(f.t.id).find((i) => i.kind === 'agent').id);
  // The thread was woken for @gamma, who has no session in the conversation: the agent a message with no mention goes to.
  f.rt.putThread({ ...f.store.state.threads[threadId], woke: 'gamma', lastSpeaker: null, members: [] });
  unregister(f, f.c);
  const sessions = Object.keys(f.store.state.sessions).length;
  const members = f.store.state.threads[f.t.id].members;
  const items = f.store.items(threadId).length;
  assert.throws(() => f.rt.sendMessage(threadId, { text: 'hi' }), { status: 422, message: REASON.replace('@beta', '@gamma') });
  assert.equal(Object.keys(f.store.state.sessions).length, sessions, 'no session made');
  assert.deepEqual(f.store.state.threads[f.t.id].members, members, 'no one joined the conversation');
  assert.deepEqual(f.store.state.threads[threadId].members, []);
  assert.equal(f.store.items(threadId).length, items, 'nothing posted');
  assert.equal(f.store.items(f.t.id).filter((i) => i.kind === 'system' && /gamma/.test(i.text ?? '')).length, 0);
});

test('#874 Retry for an agent whose backend is still missing gives another failed reply, not a 500', async () => {
  const f = await failedOnce();
  const [first] = failedIn(f, f.t.id);
  await f.rt.retry(f.t.id, first.id);
  await settle(f.rt);
  assert.equal(f.store.item(f.t.id, first.id).status, 'retried');
  const now = failedIn(f, f.t.id);
  assert.equal(now.length, 1);
  assert.notEqual(now[0].id, first.id);
  assert.equal(now[0].error, REASON);
  assert.equal(f.adapter.calls.length, 0);
});

test('#874 Retry after the backend is registered delivers the message once', async () => {
  const f = await failedOnce();
  await f.rt.retry(f.t.id, failedIn(f, f.t.id)[0].id);
  await settle(f.rt);
  const [second] = failedIn(f, f.t.id);
  const claude = Object.assign(new ScriptedAdapter(), { name: 'claude-code' });
  f.rt.adapters.register(claude);
  await f.rt.retry(f.t.id, second.id);
  await settle(f.rt);
  assert.equal(claude.calls.length, 1);
  assert.equal(claude.calls[0].message.text, 'hello');
  assert.equal(claude.calls[0].message.retry, true);
  f.rt.drainAll();
  await settle(f.rt);
  assert.equal(claude.calls.length, 1, 'exactly once');
  assert.throws(() => f.rt.retry(f.t.id, second.id), { status: 409 });
});

test('#874 an agent on a host whose backend isn’t registered fails here with the reason, asking nothing of the host', async () => {
  const r = rig();
  r.rt.adapters = new AdapterRegistry();
  const se = r.se();
  const ensured = r.hosts.calls.ensure;
  assert.doesNotThrow(() => r.rt.deliver(se.id, { kind: 'user', text: 'hello' }));
  assert.equal(r.rt.remote.live.has(se.id), false, 'nothing remote started');
  await until(() => !r.rt.turns.size && !r.rt.exiting.size, 'the turn to end');
  const failed = r.store.items(r.t.id).filter((i) => i.kind === 'agent' && i.status === 'failed');
  assert.equal(failed[0]?.error, REASON.replace('@beta', '@coder'));
  assert.equal(r.rt.remote.live.has(se.id), false);
  assert.equal(r.hosts.calls.ensure, ensured, 'the host saw no ensureWelcome');
  assert.deepEqual(r.hosts.calls.need, []);
});

test('#874 an agent whose backend is registered for hosts only still gets refuseHere’s reason', async () => {
  const f = setup();
  f.rt.adapters.register(Object.assign(new ScriptedAdapter(), { name: 'claude-code' }), { here: false });
  unregister(f, f.b);
  queued(f);
  f.rt.drainAll();
  await settle(f.rt);
  const [failed] = failedIn(f, f.t.id);
  assert.equal(failed.error, `@beta’s turn didn’t start: ${notHere(f.rt, 'claude-code')}`);
  assert.match(failed.error, /^@beta’s turn didn’t start: “claude-code” isn’t available on this computer\. Available:/);
});

test('#874 a backend name from the data is clipped in the reason', async () => {
  const hostile = `<img src=x onerror=alert(1)>"&\u0000\n${'x'.repeat(500)}`;
  const check = (error) => {
    const name = error.match(/start: “(.*)” isn’t available/s)?.[1];
    assert.ok(name, error);
    assert.ok(name.length <= 40, `${name.length} characters`);
    assert.doesNotMatch(error, /\p{Cc}/u);
    assert.ok(name.startsWith('<img src=x onerror=alert(1)>"&x'), 'as text, the control characters gone');
    assert.ok(error.length <= 200, `${error.length} characters`);
  };
  const f = setup();
  unregister(f, f.b, hostile);
  assert.throws(
    () => f.rt.sendMessage(f.t.id, { text: '@beta hi' }),
    (e) => {
      assert.equal(e.status, 422);
      check(e.message);
      return true;
    },
  );
  queued(f);
  f.rt.drainAll();
  await settle(f.rt);
  check(failedIn(f, f.t.id)[0].error);
});

test('#874 a backend name from the data loses every character that hides or reorders text, not only Cc and Cf', async () => {
  const hidden = ['\udc00', '\u3164', '\u034f', '\ufe0f', '\u{e0041}', '\u200b', '\u202e', '\ud800']; // each surrogate alone
  const f = setup();
  unregister(f, f.b, `é${hidden.join('')}日"<&`);
  queued(f);
  f.rt.drainAll();
  await settle(f.rt);
  assert.match(failedIn(f, f.t.id)[0].error, /^@beta’s turn didn’t start: “é日"<&” isn’t available on this computer\./);
});

test('#874 a handle from the data is clipped in the reason too, and a backend named like an object key isn’t looked up', async () => {
  const f = setup();
  unregister(f, f.b, 'constructor');
  f.rt.updateSession(f.beta.id, { handle: `a"<&\u0000\u202e${'b'.repeat(500)}` });
  queued(f);
  assert.doesNotThrow(() => f.rt.drainAll());
  await settle(f.rt);
  const [failed] = failedIn(f, f.t.id);
  assert.equal(failed.error.split('’s turn')[0], `@a"<&${'b'.repeat(35)}…`);
  assert.match(failed.error, /start: “constructor” isn’t available on this computer\./);
});

test('#874 a summary for an agent whose backend isn’t registered fails with Retry and doesn’t stay pending', async () => {
  const f = setup();
  f.rt.sendMessage(f.t.id, { text: '@beta hi' });
  await settle(f.rt);
  const { threadId } = f.rt.startTopic(f.t.id, f.store.items(f.t.id).find((i) => i.kind === 'agent').id);
  unregister(f, f.b);
  const calls = f.adapter.calls.length;
  assert.doesNotThrow(() => f.rt.summarizeBack(threadId));
  await settle(f.rt);
  assert.equal(failedIn(f, threadId)[0]?.error, REASON);
  assert.equal(f.store.state.threads[threadId].summaryPending, null);
  assert.equal(
    f.store.items(f.t.id).some((i) => i.kind === 'shared'),
    false,
  );
  assert.equal(f.adapter.calls.length, calls);
});

test('#874 a host turn reattached for an unregistered backend is Interrupted once, not a crash', async () => {
  const { store, d } = restarted();
  const r = rig({ store, d });
  r.rt.adapters = new AdapterRegistry();
  startUp(r);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'agent' && i.status === 'failed'), 'the failed reply');
  await until(() => !r.rt.turns.size && !r.rt.exiting.size, 'the turn to end');
  // #909: the turn can’t be followed here, so it’s Interrupted and no longer waits to be attached: a second reattach
  // adds nothing (tests/remote-turns-unregistered.test.mjs has the rest).
  await reattach(r.rt.remote, r.se().id);
  await until(() => !r.rt.turns.size && !r.rt.exiting.size, 'anything the second reattach started to end');
  const failed = r.store.items(r.t.id).filter((i) => i.kind === 'agent' && i.status === 'failed');
  assert.equal(failed.length, 1, 'one, for the first');
  assert.equal(failed[0].remote?.state, 'interrupted');
});
