// What a turn’s failure class does at its end (designs/architecture/services.md, “The end of a turn”, K and L4):
// a turn lost to the network that wasn’t a resend sends its entries once more on its own, and fails nobody (#466),
// with no blocking notification (#1218’s rule); a turn its backend refused for quota leaves the session failed and
// marked out of quota until the reset, with one info notice per backend (#442).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { withQuota } from '../server/harness-failure.mjs';
import { Runtime } from '../server/runtime.mjs';
import { stopTimers } from '../server/runtime-close.mjs';
import { needsYouNow } from '../shared/needs.mjs';
import { ScriptedAdapter, settle, setup, sleep } from './side-threads-fixture.mjs';

const lost = () => async () => {
  throw new Error('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
};
// A failure already marked by its adapter (server/harness-failure.mjs’s withQuota); each harness’s own quota event is
// read from its documented shape in tests/harness-failure.test.mjs.
const outOfQuota = (until) => async () => {
  throw withQuota(new Error('You’ve hit your usage limit.'), { until });
};

/** The notifications the runtime raises. @param {any} store */
function notes(store) {
  /** @type {any[]} */
  const got = [];
  store.subscribe((/** @type {any} */ ev) => ev.type === 'notify' && got.push(ev.data));
  return got;
}

test('#466 a turn lost to the network sends what it took once more, on its own, and the agent never fails', async () => {
  const { rt, store, t, adapter, beta } = setup();
  const heard = notes(store);
  adapter.next.push(lost());
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  assert.equal(adapter.calls.length, 2, 'the resend ran');
  assert.notEqual(store.state.sessions[beta.id].state, 'failed');
  assert.deepEqual(
    store.state.inbox[beta.id].map((e) => [e.state, e.resend]),
    [['delivered', true]],
  );
  assert.deepEqual(
    heard.filter((n) => n.level === 'blocking'),
    [],
    'nothing the person can act on',
  );
});

test('#466 a resend lost again fails the agent, and says so', async () => {
  const { rt, store, t, adapter, beta } = setup();
  const heard = notes(store);
  adapter.next.push(lost(), lost());
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  assert.equal(adapter.calls.length, 2);
  assert.equal(store.state.sessions[beta.id].state, 'failed');
  assert.deepEqual(
    store.state.inbox[beta.id].map((e) => e.state),
    ['failed'],
  );
  assert.equal(heard.filter((n) => n.level === 'blocking').length, 1);
});

test('#442 a turn refused for quota leaves the agent failed and out of quota until the reset, with an info notice', async () => {
  const { rt, store, t, adapter, beta } = setup();
  const heard = notes(store);
  const until = Date.now() + 3600_000;
  adapter.next.push(outOfQuota(until));
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  const se = store.state.sessions[beta.id];
  assert.equal(se.state, 'failed');
  assert.deepEqual(se.quota, { until });
  assert.deepEqual(
    heard.map((n) => n.level),
    ['info'],
  );
  assert.equal(needsYouNow(se), false, 'the person can’t act on it before the reset, so it doesn’t need them');
});

test('#442 every agent on the backend is out of quota, so an agent’s wake doesn’t start one into a failing turn', async () => {
  const { rt, store, t, adapter, alpha } = setup();
  const until = Date.now() + 3600_000;
  adapter.next.push(outOfQuota(until));
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  assert.deepEqual(store.state.sessions[alpha.id].quota, { until });
  rt.delivery.send({ sessionId: alpha.id, threadId: t.id, source: 'mention', text: '@alpha look', from: 'beta' }, { wake: false });
  assert.equal(rt.delivery.ready(alpha.id), false, 'a mention waits for the reset');
  rt.sendMessage(t.id, { text: '@alpha try now' });
  await settle(rt);
  assert.equal(adapter.calls.at(-1).sessionId, alpha.id, 'the person’s own message tries again');
});

test('#442 with no reset time, the notice says Postbox doesn’t know when, and that a message tries again', async () => {
  const { rt, store, t, adapter } = setup();
  const heard = notes(store);
  adapter.next.push(outOfQuota(null));
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  assert.equal(heard.length, 1);
  assert.match(heard[0].text, /doesn’t know when/);
  assert.doesNotMatch(JSON.stringify(heard[0]), /once its quota resets/);
});

/** A failed agent out of quota until `until`, with its own scheduled wake waiting for the reset. */
async function waitingForReset(until) {
  const f = setup();
  f.adapter.next.push(outOfQuota(until));
  f.rt.sendMessage(f.t.id, { text: '@beta go' });
  await settle(f.rt);
  f.rt.delivery.send({ sessionId: f.beta.id, threadId: f.t.id, source: 'scheduled', text: 'Check the run.' }, { wake: false });
  return f;
}
const scheduledCalls = (/** @type {any} */ adapter) => adapter.calls.filter((c) => /Check the run/.test(JSON.stringify(c.message)));

test('#442 at the reset, the agent’s scheduled wake starts on its own', async () => {
  const { rt, adapter } = await waitingForReset(Date.now() + 80);
  assert.equal(scheduledCalls(adapter).length, 0);
  await sleep(200);
  await settle(rt);
  assert.equal(scheduledCalls(adapter).length, 1);
});

test('#442 after a restart, the reset still wakes the agent’s scheduled wake', async () => {
  const f = await waitingForReset(Date.now() + 150);
  stopTimers(f.rt);
  const after = new ScriptedAdapter();
  const again = new Runtime({ store: f.store, adapters: new AdapterRegistry().register(after), config: f.rt.config });
  after.rt = again;
  again.drainAll();
  await settle(again);
  assert.equal(scheduledCalls(after).length, 0, 'not before the reset');
  await sleep(300);
  await settle(again);
  assert.equal(scheduledCalls(after).length, 1);
  stopTimers(again);
});

test('#466 a lost turn’s resend goes before the person’s newer message', async () => {
  const { rt, t, adapter } = setup();
  let go = () => {};
  const gate = new Promise((r) => {
    go = () => r(undefined);
  });
  adapter.next.push(async (/** @type {any} */ c) => {
    c.text('working');
    await gate;
    await lost()();
  });
  rt.sendMessage(t.id, { text: '@beta first' });
  await sleep(20);
  rt.sendMessage(t.id, { text: '@beta second' });
  await sleep(20);
  go();
  await settle(rt);
  const sent = adapter.calls.map((c) => JSON.stringify(c.message));
  assert.match(sent[0], /first/);
  assert.match(sent[1], /first/, 'the resend of what was lost comes first');
});

test('#442 two agents on one backend out of quota raise one notice', async () => {
  const { rt, store, t, adapter } = setup();
  const heard = notes(store);
  adapter.next.push(outOfQuota(null), outOfQuota(null));
  rt.sendMessage(t.id, { text: '@alpha go' });
  await settle(rt);
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  assert.equal(heard.length, 1);
});

test('#442 the agent’s next turn clears its quota', async () => {
  const { rt, store, t, adapter, beta } = setup();
  adapter.next.push(outOfQuota(null));
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  assert.ok(store.state.sessions[beta.id].quota);
  rt.sendMessage(t.id, { text: '@beta again' });
  await settle(rt);
  assert.equal(store.state.sessions[beta.id].quota ?? null, null);
  assert.notEqual(store.state.sessions[beta.id].state, 'failed');
});

test('#442 the agent’s own scheduled wake doesn’t start it before its quota resets', async () => {
  const { rt, store, t, adapter, beta } = setup();
  adapter.next.push(outOfQuota(Date.now() + 3600_000));
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  rt.delivery.send({ sessionId: beta.id, threadId: t.id, source: 'scheduled', text: 'Check the run.' }, { wake: false });
  assert.equal(rt.delivery.ready(beta.id), false);
  rt.sessions.update(beta.id, { quota: { until: Date.now() - 1 } });
  assert.equal(rt.delivery.ready(beta.id), true);
  assert.ok(store.state.sessions[beta.id]);
});
