// #1713: what ends an agent’s wait to try a turn again after its provider failed. Any other failure (it then needs the
// person), a later failure of its own, Dismiss and Stop each end the wait, so no row says “retrying” at a time past,
// and a wait that ended starts nothing when its timer comes (#1713). The waits are the test’s own
// clock (config.retryAfter), as in turn-transient.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dismissFailed } from '../server/card-needs.mjs';
import { withQuota, withTransient } from '../server/harness-failure.mjs';
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
  const reply = f.store.item(f.t.id, failed.id);
  assert.equal(reply.note ?? null, null, 'its note no longer says when it would try');
  assert.equal(reply.transient.at, null);
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

test('#1713 a turn the person started meanwhile moves past the failed one: the wait’s end runs nothing', async () => {
  // #1713: the person wrote something new while the agent waited, and that turn still ran when
  // the wait ended; the old turn went again after it, a turn the person had moved past.
  const f = room();
  await overloadedOnce(f);
  const work = held();
  f.adapter.next.push(work.step);
  f.rt.sendMessage(f.t.id, { text: '@beta new task instead' });
  await sleep(5);
  const calls = f.adapter.calls.length;
  f.waits.shift()();
  work.release();
  await settle(f.rt);
  assert.equal(f.adapter.calls.length, calls, 'only the person’s new turn ran');
});

test('#1713 a turn that started a tool goes again too, told to check what ran before repeating it', async () => {
  // #1713: a turn with N tool calls meets the provider N+1 times, so most 529s come after a tool. Its retry carries a
  // line to check what ran, as a scheduled wake’s recovery does (designs/508/design.md, “Record lifecycles”).
  const f = room();
  f.adapter.next.push(async (/** @type {any} */ ctx) => {
    ctx.activity?.({ id: 'tu1', label: 'Bash: git push', state: 'running', kind: 'tool' });
    throw withTransient(new Error('API Error: 529 Overloaded'), 529);
  });
  f.rt.sendMessage(f.t.id, { text: '@beta push it' });
  await settle(f.rt);
  assert.equal(f.waits.length, 1, 'it waits to go again');
  assert.deepEqual(f.se().autoRetry.started, ['Bash: git push']);
  assert.equal(needsYouNow(f.se()), false);
  f.waits.shift()();
  await settle(f.rt);
  const retried = JSON.stringify(f.adapter.calls.at(-1).message.context);
  assert.match(retried, /after it had started work: Bash: git push/, 'the retry is told what ran');
  assert.match(retried, /Check what those calls changed or sent before you repeat any of them/);
});

test('#1713 a retry Postbox couldn’t start ends the wait and needs the person, and the reply keeps its Retry', async () => {
  const f = room();
  await overloadedOnce(f);
  const failed = f.store.items(f.t.id).find((i) => i.kind === 'agent' && i.sessionId === f.beta.id);
  f.rt.turnService.retry = async () => {
    throw Object.assign(new Error('the backend is gone'), { status: 500 });
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    f.waits.shift()();
    await settle(f.rt);
  } finally {
    console.warn = warn;
  }
  assert.equal(f.se().autoRetry ?? null, null);
  assert.equal(f.se().currentStep, 'Failed');
  assert.equal(agentState(f.se(), f.store.state).state, 'failed');
  assert.equal(needsYouNow(f.se()), true, 'nothing else starts it again, so it needs the person');
  const reply = f.store.item(f.t.id, failed.id);
  assert.equal(reply.status, 'failed');
  assert.equal(reply.note ?? null, null, 'its note no longer says when it would try');
});

test('#1713 a retry its backend refused for quota ends the wait, and waits for the quota instead', async () => {
  const f = room();
  await overloadedOnce(f);
  f.adapter.next.push(async () => {
    throw withQuota(new Error('You’ve hit your limit'), { until: Date.now() + 3_600_000 });
  });
  f.waits.shift()();
  await settle(f.rt);
  assert.equal(f.se().autoRetry ?? null, null);
  assert.notEqual(agentState(f.se(), f.store.state).state, 'retrying');
});

test('#1713 a tool-started turn whose retry was refused takes back its line to check what ran', async () => {
  const f = room();
  f.adapter.next.push(async (/** @type {any} */ ctx) => {
    ctx.activity?.({ id: 'tu1', label: 'Bash: git push', state: 'running', kind: 'tool' });
    throw withTransient(new Error('API Error: 529 Overloaded'), 529);
  });
  f.rt.sendMessage(f.t.id, { text: '@beta push it' });
  await settle(f.rt);
  f.rt.turnService.retry = async () => {
    throw Object.assign(new Error('the backend is gone'), { status: 500 });
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    f.waits.shift()();
    await settle(f.rt);
  } finally {
    console.warn = warn;
  }
  assert.equal(
    (f.se().context ?? []).some((/** @type {string} */ x) => /Check what those calls changed/.test(x)),
    false,
  );
});
