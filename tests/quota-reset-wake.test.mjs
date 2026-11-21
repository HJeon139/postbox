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
 * Arranges a test with the clock held at one reading, so the reset is still ahead when the wake it’s meant to start is
 * waiting, however long a loaded runner takes to get there: a reset timer that fires meanwhile reads the held clock,
 * before the reset, and arms itself again, as an early fire does. The real clock comes back once `arrange` settles,
 * whether it returns or throws. @template T @param {(at: number) => Promise<T>} arrange  given the held reading
 * @returns {Promise<T>}
 */
async function withClockHeld(arrange) {
  const real = Date.now;
  const at = real();
  Date.now = () => at;
  try {
    return await arrange(at);
  } finally {
    Date.now = real;
  }
}

/** A restarted runtime whose agent waits for a reset 150 ms past the held clock, its next turn awaited. */
const restartedWaiting = () =>
  withClockHeld(async (at) => {
    const until = at + 150;
    const { after, again } = restarted(await waitingForReset(until));
    const started = nextTurn(after, 2000);
    again.drainAll();
    return { until, after, again, started };
  });

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
  const { until, rt, adapter, started } = await withClockHeld(async (at) => {
    const until = at + 80;
    const f = await waitingForReset(until);
    assert.equal(scheduledCalls(f.adapter).length, 0);
    return { ...f, until, started: nextTurn(f.adapter) };
  });
  assert.ok((await started) >= until, 'not before the reset');
  await settle(rt);
  assert.equal(scheduledCalls(adapter).length, 1);
});

test('#442 after a restart, the reset still wakes the agent’s scheduled wake', async () => {
  const { until, after, again, started } = await restartedWaiting();
  assert.ok((await started) >= until, 'not before the reset');
  await settle(again);
  assert.equal(scheduledCalls(after).length, 1);
  stopTimers(again);
});

test('#442 a reset timer that fires before the clock reads the reset arms itself again, and wakes the agent', async () => {
  const { until, after, again, started } = await restartedWaiting();
  // Armed: from the timer’s first reading, the clock reads 40 ms behind the reset until just past it, as when a timer
  // fires before Date.now() reaches the time it was set for, which Node’s timers do now and then. The lag is set at that
  // reading, so a loaded runner that fires the timer late still takes the early path.
  const real = Date.now;
  const fromQuota = () => (new Error().stack ?? '').includes('turn-quota.mjs');
  let lag = /** @type {number | null} */ (null);
  let early = 0;
  Date.now = () => {
    const now = real();
    if (lag === null && fromQuota()) lag = Math.max(40, now - until + 40);
    if (lag === null || now - lag >= until + 30) return now;
    if (now - lag < until && fromQuota()) early += 1;
    return now - lag;
  };
  try {
    assert.ok((await started) >= until, 'woken once the clock reads the reset');
    assert.ok(early > 0, 'the timer fired early, as the test stubbed it');
  } finally {
    Date.now = real;
  }
  await settle(again);
  assert.equal(scheduledCalls(after).length, 1);
  stopTimers(again);
});

test('#442 the re-arm reads the clock the early timer read, so a millisecond ticking between them can’t drop the wake', async () => {
  const { until, again, started } = await restartedWaiting();
  // Armed: the timer’s callback reads until - 1, an early fire, and anything in armReset after it reads until, as when
  // the millisecond ticks between the two reads. Each happens once; every other read is the real clock.
  const real = Date.now;
  let early = false;
  let ticked = false;
  Date.now = () => {
    const at = new Error().stack ?? '';
    const inQuota = at.includes('turn-quota.mjs');
    if (inQuota && !at.includes('at armReset') && !early && real() >= until - 1) {
      early = true;
      return until - 1;
    }
    if (inQuota && at.includes('at armReset') && early && !ticked) {
      ticked = true;
      return until;
    }
    return real();
  };
  try {
    assert.ok((await started) >= until, 'woken at the reset');
    assert.ok(early, 'the timer fired early, as the test stubbed it');
  } finally {
    Date.now = real;
  }
  await settle(again);
  stopTimers(again);
});
