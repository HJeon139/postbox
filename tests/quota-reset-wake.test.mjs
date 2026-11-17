// The reset of a quota an agent ran out of (#442): at the reset, the agent’s scheduled wake starts on its own, and a
// restart arms the reset again from the sessions (server/turn-quota.mjs). Moved from turn-failure-classes.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { withQuota } from '../server/harness-failure.mjs';
import { Runtime } from '../server/runtime.mjs';
import { stopTimers } from '../server/runtime-close.mjs';
import { ScriptedAdapter, settle, setup } from './side-threads-fixture.mjs';

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

/**
 * When the agent’s next turn starts: resolves with the clock then, or rejects after `ms`. The test waits on the turn
 * itself, not a sleep that a slow runner outlasts. @param {any} adapter @param {number} [ms]
 */
function nextTurn(adapter, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the scheduled wake never started')), ms);
    adapter.next.push(async (/** @type {any} */ c) => {
      clearTimeout(timer);
      resolve(Date.now());
      c.text('ok');
    });
  });
}

/** A restart of f’s runtime on its store, with a new adapter. @param {any} f */
function restarted(f) {
  stopTimers(f.rt);
  const after = new ScriptedAdapter();
  const again = new Runtime({ store: f.store, adapters: new AdapterRegistry().register(after), config: f.rt.config });
  after.rt = again;
  return { after, again };
}

test('#442 at the reset, the agent’s scheduled wake starts on its own', async () => {
  const until = Date.now() + 80;
  const { rt, adapter } = await waitingForReset(until);
  assert.equal(scheduledCalls(adapter).length, 0);
  assert.ok((await nextTurn(adapter)) >= until, 'not before the reset');
  await settle(rt);
  assert.equal(scheduledCalls(adapter).length, 1);
});

test('#442 after a restart, the reset still wakes the agent’s scheduled wake', async () => {
  const until = Date.now() + 150;
  const { after, again } = restarted(await waitingForReset(until));
  const started = nextTurn(after);
  again.drainAll();
  assert.ok((await started) >= until, 'not before the reset');
  await settle(again);
  assert.equal(scheduledCalls(after).length, 1);
  stopTimers(again);
});

test('#442 a reset timer that fires before the clock reads the reset arms itself again, and wakes the agent', async () => {
  const until = Date.now() + 150;
  const { after, again } = restarted(await waitingForReset(until));
  const started = nextTurn(after, 2000);
  again.drainAll();
  // Armed: now the clock reads 40 ms behind until just past the reset, as when a timer fires before Date.now() reaches
  // the time it was set for, which Node’s timers do now and then.
  const real = Date.now;
  Date.now = () => (real() < until + 30 ? real() - 40 : real());
  try {
    assert.ok((await started) >= until, 'woken once the clock reads the reset');
  } finally {
    Date.now = real;
  }
  await settle(again);
  assert.equal(scheduledCalls(after).length, 1);
  stopTimers(again);
});
