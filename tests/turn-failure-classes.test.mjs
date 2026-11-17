// What a turn’s failure class does at its end (designs/architecture/services.md, “The end of a turn”, K and L4):
// a turn lost to the network that wasn’t a resend sends its entries once more on its own, and fails nobody (#466),
// with no blocking notification (#1218’s rule); a turn its backend refused for quota leaves the session failed and
// marked out of quota until the reset, with one info notice per backend (#442).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withQuota } from '../server/harness-failure.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

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
