// #1713: what ends an agent’s wait to try a turn again after its provider failed. Any other failure (it then needs the
// person), a later failure of its own, Dismiss and Stop each end the wait, so no row says “retrying” at a time past,
// and a wait that ended starts nothing when its timer comes (pre-review of PR #1717). The waits are the test’s own
// clock (config.retryAfter), as in turn-transient.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dismissFailed } from '../server/card-needs.mjs';
import { withTransient } from '../server/harness-failure.mjs';
import { agentState } from '../shared/agent-state.mjs';
import { needsYouNow } from '../shared/needs.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

const overloaded = () => async () => {
  throw withTransient(new Error('API Error: 529 Overloaded'), 529);
};

/** setup()’s runtime, with each wait held for the test to end. */
function room() {
  const f = setup();
  /** @type {(() => void)[]} */
  const waits = [];
  f.rt.config.retryAfter = (/** @type {number} */ _ms, /** @type {() => void} */ fn) => waits.push(fn);
  const se = () => f.store.state.sessions[f.beta.id];
  return { ...f, waits, se };
}

/** The first turn fails with a 529, and waits to go again. */
async function overloadedOnce(f) {
  f.adapter.next.push(overloaded());
  f.rt.sendMessage(f.t.id, { text: '@beta go' });
  await settle(f.rt);
  assert.equal(agentState(f.se(), f.store.state).state, 'retrying');
}

test('#1713 a retry that fails for another reason needs the person, and its row says failed, not retrying', async () => {
  const f = room();
  await overloadedOnce(f);
  f.adapter.next.push(async () => {
    throw new Error('boom');
  });
  f.waits.shift()();
  await settle(f.rt);
  assert.equal(f.se().autoRetry ?? null, null);
  assert.equal(agentState(f.se(), f.store.state).state, 'failed');
  assert.equal(needsYouNow(f.se()), true);
});

test('#1713 a later failure of its own ends the earlier wait: that wait’s end starts nothing', async () => {
  const f = room();
  await overloadedOnce(f);
  // The person writes meanwhile, and that turn fails for its provider too: a wait of its own.
  f.adapter.next.push(overloaded());
  f.rt.sendMessage(f.t.id, { text: '@beta and this' });
  await settle(f.rt);
  const calls = f.adapter.calls.length;
  const first = f.store.items(f.t.id).find((i) => i.kind === 'agent' && i.sessionId === f.beta.id);
  assert.equal(f.waits.length, 2);
  f.waits.shift()();
  await settle(f.rt);
  assert.equal(f.adapter.calls.length, calls, 'the first wait’s end ran nothing');
  assert.equal(f.store.item(f.t.id, first.id).status, 'failed', 'and left its reply failed, with Retry');
});

test('#1713 Dismiss ends the wait: its end runs nothing, and the row no longer says retrying', async () => {
  const f = room();
  await overloadedOnce(f);
  const failed = f.store.items(f.t.id).find((i) => i.kind === 'agent' && i.sessionId === f.beta.id);
  dismissFailed(f.rt, f.t.id, failed.id);
  assert.equal(f.se().autoRetry ?? null, null);
  const calls = f.adapter.calls.length;
  f.waits.shift()();
  await settle(f.rt);
  assert.equal(f.adapter.calls.length, calls);
});

test('#1713 Stop of the retried turn ends the count', async () => {
  const f = room();
  await overloadedOnce(f);
  const work = held();
  f.adapter.next.push(work.step);
  f.waits.shift()();
  await sleep(5);
  f.rt.stop(f.beta.id);
  work.release();
  await settle(f.rt);
  assert.equal(f.se().autoRetry ?? null, null);
});
