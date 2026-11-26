// #1760: in #1746’s second stretch the UAT runner’s tester had no step for nine minutes while an agent’s turn was open,
// and run.log said nothing of it. The wait between steps says so once, at STALL_MS, and the run records it as a finding
// of the runner’s own (tools/uat/stall.mjs). The wait itself goes on to its bounds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kindOf } from '../tools/uat/stats.mjs';
import { settle, WAIT_MAX_S } from '../tools/uat/turns.mjs';
import { onFakeClock } from './uat-fake-clock.mjs';
import { ASK, heldRoom, waitCtx } from './uat-held-room.mjs';

// Read as it is, so the tests run (and fail on what they say) against the code from before the fix too.
const { STALL_MS = 5 * 60_000, stalledFinding = () => null } = /** @type {any} */ (await import('../tools/uat/stall.mjs').catch(() => ({})));

/** A wait between steps over `api`, with what it said and recorded: the stalled lines, and what onStall was given. */
async function waited(/** @type {any} */ t, /** @type {() => Promise<any>} */ api, over = {}) {
  /** @type {string[]} */
  const stalls = [];
  const ctx = waitCtx(api, { onStall: (/** @type {string} */ evidence) => stalls.push(evidence), ...over });
  const r = await onFakeClock(t, async () => ({ out: await settle(ctx), took: Date.now() }));
  return { ...r, stalls, d: ctx.d, said: ctx.lines.filter((l) => /^stalled/.test(l)) };
}
// The ask the tester has had and left: the wait hands nothing back for it, as after a second next_phase.
const left = () => ({ told: new Set([ASK.id]) });

test('a wait that leaves the tester without a step for STALL_MS while a turn is open says so once, and the run records it', async (t) => {
  const r = await waited(t, heldRoom({ endAt: 600_000 }), left());
  assert.equal(STALL_MS, 5 * 60_000);
  assert.ok(STALL_MS >= WAIT_MAX_S * 1000, 'no wait the tester asks for itself outlasts it');
  assert.deepEqual(r.said, [
    'stalled: the tester has had no step for 5 min while @researcher works; waiting on the person: @researcher’s choice “Fix the load script?”',
  ]);
  assert.deepEqual(r.stalls, [r.said[0].replace(/^stalled: /, '')], 'the finding’s evidence is the line’s');
  assert.equal(r.out, null);
  assert.ok(r.took >= 600_000, `and the wait went on to the turn’s end (${r.took} ms)`);
  // A finding of the runner’s own, which the report’s curves count as the harness’s.
  const f = stalledFinding(r.stalls[0], 7);
  assert.deepEqual(f, {
    source: 'run',
    check: 'stalled',
    issue: null,
    title: 'The tester had no step for 5 minutes while a turn was open',
    evidence: r.stalls[0],
    step: 7,
  });
  assert.equal(kindOf(f), 'runner');
});

test('a stalled wait still ends at the turn’s time limit, by pressing Stop', async (t) => {
  const r = await waited(t, heldRoom({ endAt: Infinity }), left());
  assert.match(String(r.out), /An agent was still working after 900 s, so the run pressed Stop\./);
  assert.equal(r.d.at.stop, r.took, 'Stop at the limit');
  assert.ok(r.took >= 900_000 && r.took < 903_000, `the wait ended at ${r.took} ms`);
  assert.equal(r.said.length, 1, 'with one stalled line in its ten minutes past the first');
  assert.equal(r.stalls.length, 1);
});

test('a stall with nothing waiting says so', async (t) => {
  const r = await waited(t, heldRoom({ endAt: 400_000, asks: [] }));
  assert.deepEqual(r.said, ['stalled: the tester has had no step for 5 min while @researcher works; nothing waits on the person']);
});

test('a turn that ends before STALL_MS is no stall', async (t) => {
  const r = await waited(t, heldRoom({ endAt: STALL_MS - 3000 }), left());
  assert.ok(r.took >= STALL_MS - 3000, `the wait ran ${r.took} ms`);
  assert.deepEqual([r.said, r.stalls], [[], []]);
});

test('the run’s last wait, with no step left to give, is no stall', async (t) => {
  const r = await waited(t, heldRoom({ endAt: 400_000 }), { ...left(), handBack: false });
  assert.ok(r.took >= 400_000, `the wait ran ${r.took} ms`);
  assert.deepEqual([r.said, r.stalls], [[], []]);
});

test('a wait held by an app’s check, with no agent at a turn, is no stall', async (t) => {
  // An app being checked holds the wait with nobody working (#1664): no turn is open, so no step is owed.
  const api = async () => {
    const now = Date.now();
    const se = { id: ASK.sessionId, handle: 'researcher', threadId: 'th_main', state: 'idle' };
    const apps = now < 400_000 ? { app_1: { id: 'app_1', threadId: 'th_main', check: { status: 'pending' } } } : {};
    return { state: { threads: { th_main: { id: 'th_main', members: [se.id] } }, sessions: { [se.id]: se }, apps, items: { th_main: [] } } };
  };
  const r = await waited(t, api);
  assert.ok(r.took >= 400_000, `the wait ran ${r.took} ms, past STALL_MS`);
  assert.deepEqual([r.said, r.stalls], [[], []]);
});
