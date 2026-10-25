// #289: the runner’s send_then_stop and its wait between steps (tools/uat/turns.mjs). In the p0 run of 24 October
// (uat-runs/2026-10-24T21-34-10-p0), the tester asked to press Stop 40 s after sending; the runner pressed it at 10 s,
// Postbox asked whether to stop the background job too (events.jsonl, seq 2721: stopAsk { jobs: 1 }, the session still
// at work), and the runner waited for the turn to end three minutes later instead of showing the question to the
// tester, which then reported that Stop did nothing. node:test’s mock timers stand in for the clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopAskText } from '../server/runtime.mjs';
import { JOBS_ANSWERS } from '../tools/uat/driver.mjs';
import * as turns from '../tools/uat/turns.mjs';

// Read from the module, so the test runs (and fails) against the code from before the fix too.
const { sendThenStop, settle, STOP_AFTER_MAX_S, BLOCK_GRACE_MS } = /** @type {any} */ (turns);

/** Runs `work` while the fake clock moves on a quarter second at a time, until it settles or 20 fake minutes pass. */
async function onFakeClock(t, work) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let out = null;
  const p = work().then(
    (value) => (out = { value }),
    (error) => (out = { error }),
  );
  try {
    for (let ms = 0; !out && ms < 20 * 60_000; ms += 250) {
      for (let i = 0; i < 5; i++) await new Promise(setImmediate);
      if (!out) t.mock.timers.tick(250);
    }
    await p;
  } finally {
    t.mock.timers.reset();
  }
  if (out?.error) throw out.error;
  return out?.value;
}

// What the driver reads of Postbox’s ask (driver.mjs, jobsAsk): the row’s text, then its buttons.
const ASK = `${stopAskText('researcher', 1)} ${JOBS_ANSWERS.stop[0]} ${JOBS_ANSWERS.keep[0]}`;

/**
 * A fake driver: when it was told to send and to stop, and Postbox’s question once Stop is pressed on a turn with a job.
 * With `doneAt`, the reply finished then, and Stop isn’t on screen after, as driver.mjs’s stopAll says.
 */
function fakeDriver({ job = true, doneAt = Infinity } = {}) {
  const at = { send: null, stop: null };
  return {
    at,
    send: async () => {
      at.send = Date.now();
    },
    stopAll: async () => {
      if (Date.now() >= doneAt) throw new Error('No Stop control is visible.');
      at.stop = Date.now();
    },
    jobsAsk: async () => (job && at.stop !== null ? ASK : null),
    working: async () => [],
  };
}

test('send_then_stop presses Stop after the seconds the tester asked for, and hands it the job question', async (t) => {
  const d = fakeDriver();
  const probes = { interrupts: [] };
  const lines = [];
  const said = await onFakeClock(t, () =>
    sendThenStop(d, { type: 'send_then_stop', text: 'start the heartbeat', seconds: 40 }, { step: 15, probes, log: (l) => lines.push(l) }),
  );
  assert.equal(d.at.stop - d.at.send, 40_000, 'Stop 40 s after sending, not 10');
  assert.match(said, /after 40 s/);
  assert.match(said, /Postbox asks: “@researcher has 1 background job running\. Stop it too\?/);
  assert.match(said, /Answer it with jobs/);
  // The interrupt is on the run’s record, for the triggers and the report, and in its log.
  assert.equal(probes.interrupts.length, 1);
  assert.deepEqual({ ...probes.interrupts[0], at: null }, { step: 15, at: null, do: 'stop', after: 40, stopped: true, asked: ASK, answered: null });
  assert.ok(
    lines.some((l) => /Stop .*40 s.*background job/.test(l)),
    lines.join('\n'),
  );
});

test('send_then_stop waits at most STOP_AFTER_MAX_S, and says so', async (t) => {
  const d = fakeDriver({ job: false });
  const said = await onFakeClock(t, () => sendThenStop(d, { type: 'send_then_stop', text: 'x', seconds: 4000 }, { step: 2, probes: { interrupts: [] } }));
  assert.equal(d.at.stop - d.at.send, STOP_AFTER_MAX_S * 1000);
  assert.match(said, new RegExp(`you asked for 4000 s; the run waits 1 to ${STOP_AFTER_MAX_S} s`));
  assert.match(said, /didn’t ask about background jobs/);
});

test('send_then_stop says so when the reply finished before the delay, and still records it', async (t) => {
  const d = fakeDriver({ doneAt: 25_000 });
  const probes = { interrupts: [] };
  let checks = 0;
  const said = await onFakeClock(t, () => sendThenStop(d, { text: 'x', seconds: 40 }, { step: 3, probes, onWait: async () => void checks++ }));
  assert.equal(said, 'No reply was working after 40 s, so nothing was stopped: it had finished.');
  assert.equal(probes.interrupts[0].stopped, false);
  // The mid-turn checks ran while it waited, every 5 s, as during an interrupt’s wait.
  assert.equal(checks, 7);
});

/**
 * Postbox’s state as the p0 run’s history has it: @researcher at work on a turn with one background job, Stop’s
 * question on screen from `askAt` (seq 2721) until the turn ends at `endAt`, three minutes later.
 */
function fakeApi({ askAt = 0, endAt = 180_000, block = null } = {}) {
  return async () => {
    const now = Date.now();
    const busy = now < endAt;
    const se = {
      id: 'se_M1rU2SmH',
      handle: 'researcher',
      threadId: 'th_main',
      state: busy ? 'tool' : 'idle',
      stopAsk: busy && askAt !== null && now >= askAt ? { at: askAt, jobs: 1 } : null,
      jobs: [{ id: 'bphfrvil3', state: busy ? 'running' : 'done', kept: false, turnId: 'turn_2XIkmVb5' }],
    };
    const items = block && now >= block.at ? [{ id: 'it_ask', kind: 'block', handle: 'researcher', block: { type: 'choice', prompt: 'Which file?' } }] : [];
    if (block && now >= block.at) se.state = now < (block.endAt ?? endAt) ? 'gen' : 'idle';
    return { state: { threads: { th_main: { id: 'th_main', members: [se.id] } }, sessions: { [se.id]: se }, apps: {}, items: { th_main: items } } };
  };
}
const ctx = (api, over = {}) => ({
  api,
  d: fakeDriver(),
  threadsUnderTest: () => ['th_main'],
  facts: { samples: [] },
  midTurnChecks: async () => {},
  opt: { 'turn-timeout': '900' },
  ...over,
});

test('the wait between steps hands back to the tester as soon as Stop asks about a background job', async (t) => {
  const told = new Set();
  const lines = [];
  const r = await onFakeClock(t, async () => {
    const out = await settle(ctx(fakeApi(), { told, handBack: true, log: (l) => lines.push(l) }));
    return { out, took: Date.now() };
  });
  assert.equal(r.out, null, 'not a turn past the time limit');
  // The fake clock starts at 0.
  assert.ok(r.took < 5000, `handed back after ${r.took} ms, not when the turn ended at 180 s`);
  assert.ok(
    lines.some((l) => /@researcher/.test(l) && /background job/.test(l)),
    lines.join('\n'),
  );
  // Handed back once: if the tester leaves the question, the next wait lasts until the turn ends, as before.
  const again = await onFakeClock(t, async () => {
    await settle(ctx(fakeApi({ endAt: 60_000 }), { told, handBack: true }));
    return Date.now();
  });
  assert.ok(again >= 60_000, `waited for the turn the second time (${again} ms)`);
});

test('the wait hands back a block that asks once its turn has gone on BLOCK_GRACE_MS past it', async (t) => {
  const took = await onFakeClock(t, async () => {
    await settle(ctx(fakeApi({ askAt: null, block: { at: 20_000 } }), { told: new Set(), handBack: true }));
    return Date.now();
  });
  assert.equal(BLOCK_GRACE_MS, 10_000);
  assert.ok(took >= 20_000 + BLOCK_GRACE_MS && took < 20_000 + BLOCK_GRACE_MS + 2000, `handed back at ${took} ms`);
});

test('a block whose turn ends a few seconds after it is shown when the turn ends, not while its reply is written', async (t) => {
  // As in the recorded runs: the turn ends 2.5 to 4.3 s after the block, on a closing line.
  const took = await onFakeClock(t, async () => {
    await settle(ctx(fakeApi({ askAt: null, block: { at: 20_000, endAt: 24_000 } }), { told: new Set(), handBack: true }));
    return Date.now();
  });
  assert.ok(took >= 24_000 && took < 28_000, `the wait ended once the turn did (${took} ms), with the room calm`);
});

test('the wait after the last step still lets the turn finish: nobody is left to answer', async (t) => {
  const took = await onFakeClock(t, async () => {
    await settle(ctx(fakeApi({ endAt: 30_000 }), { told: new Set() }));
    return Date.now();
  });
  assert.ok(took >= 30_000, `waited until the turn ended (${took} ms)`);
});
