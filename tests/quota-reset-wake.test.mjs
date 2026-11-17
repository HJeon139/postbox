// The reset of a quota an agent ran out of (#442): at the reset, the agent’s scheduled wake starts on its own, and a
// restart arms the reset again from the sessions (server/turn-quota.mjs). Moved from turn-failure-classes.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { withQuota } from '../server/harness-failure.mjs';
import { Runtime } from '../server/runtime.mjs';
import { stopTimers } from '../server/runtime-close.mjs';
import { ScriptedAdapter, settle, setup, sleep } from './side-threads-fixture.mjs';

// A failure already marked by its adapter (server/harness-failure.mjs’s withQuota).
const outOfQuota = (until) => async () => {
  throw withQuota(new Error('You’ve hit your usage limit.'), { until });
};

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
