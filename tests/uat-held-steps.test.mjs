// #1760 (#1746’s second stretch): the UAT runner handed an ask to the tester once, while its agent still worked. The
// tester answered next_phase, the runner held it (“action held: 1 waiting on the person”), and the wait after gave the
// tester no step, since the ask had been handed back already and the turn was open: nine minutes, until the run ended.
// These run the step loop’s own parts in its order (tools/uat-run.mjs: the wait, the waiting list, the hold, the
// prompt) on a fake clock, with no page and no tester model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stepHolds, waitingList } from '../tools/uat/held-steps.mjs';
import { writeReport } from '../tools/uat/report.mjs';
import { BLOCK_GRACE_MS, settle } from '../tools/uat/turns.mjs';
import { tempDir } from './temp-dirs.mjs';
import { onFakeClock } from './uat-fake-clock.mjs';
import { ASK, heldRoom, promptFor, SECOND_ASK, THREADS, waitCtx } from './uat-held-room.mjs';

const WHAT = '@researcher’s choice “Fix the load script?”';
const count = (/** @type {string} */ text, /** @type {string} */ part) => text.split(part).length - 1;

/**
 * A run’s step loop, as tools/uat-run.mjs has it. `next` is the top of a step: it waits on the agents’ turns, handing
 * back again what waits when the last action didn’t happen, then reads what waits and writes the tester’s prompt.
 */
function stepLoop(/** @type {() => Promise<any>} */ api) {
  const ctx = waitCtx(api);
  const labels = new Map([[ASK.id, 'I4']]);
  const holdFor = stepHolds({ goals: { leave: () => null }, log: ctx.log, timeline: [] });
  /** @param {{ lastAction?: any, actionError?: string | null }} [last] */
  const next = async ({ lastAction = null, actionError = null } = {}) => {
    const from = ctx.lines.length;
    await settle({ ...ctx, again: actionError !== null });
    const waiting = waitingList((await api()).state, THREADS, { labels, mainThread: 'th_main' });
    return {
      at: Date.now(),
      waiting,
      prompt: promptFor({ waiting, lastAction, actionError }),
      handed: ctx.lines.slice(from).filter((l) => /^handed back/.test(l)),
    };
  };
  return { next, holdFor, lines: ctx.lines };
}

test('after a held next_phase, what still waits is in front of the tester at its next step, not when the turn ends', async (t) => {
  const r = await onFakeClock(t, async () => {
    const run = stepLoop(heldRoom({ endAt: 600_000 }));
    const first = await run.next();
    const lastAction = { type: 'next_phase' };
    const actionError = run.holdFor(lastAction, { waiting: first.waiting, idle: false, phase: 0 });
    const second = await run.next({ lastAction, actionError });
    return { first, actionError, second, lines: run.lines };
  });
  assert.ok(r.first.at < BLOCK_GRACE_MS + 3000, `the ask was handed back once its grace was over (${r.first.at} ms)`);
  assert.equal(r.actionError?.startsWith(`Not yet: this is still waiting on you: [I4] ${WHAT}.`), true, String(r.actionError));
  assert.ok(r.lines.includes(`action held: 1 waiting on the person: [I4] ${WHAT}`), r.lines.join('\n'));
  // The stall: on the code before the fix the second step came at 600 s, when the turn ended.
  assert.ok(r.second.at - r.first.at < 5000, `the tester got its next step ${r.second.at - r.first.at} ms after the held one`);
  assert.deepEqual(r.second.handed, [`handed back again while @researcher works: ${WHAT}`]);
  // What it is and where, in the step the tester reads: the refusal, and the list with the item’s label.
  assert.match(r.second.prompt, /It failed: Not yet: this is still waiting on you: \[I4\] @researcher’s choice “Fix the load script\?”/);
  assert.match(r.second.prompt, /Waiting on you:\n- \[I4\] @researcher’s choice “Fix the load script\?”$/);
});

test('an ask in a thread that isn’t open is handed back with the thread to open', async (t) => {
  const r = await onFakeClock(t, async () => {
    const run = stepLoop(heldRoom({ asks: [{ item: SECOND_ASK, thread: 'th_side' }] }));
    const first = await run.next();
    const actionError = run.holdFor({ type: 'done' }, { waiting: first.waiting, idle: false, phase: 0 });
    return { first, second: await run.next({ lastAction: { type: 'done' }, actionError }) };
  });
  assert.ok(r.second.at - r.first.at < 5000, `the next step came ${r.second.at - r.first.at} ms after the held one`);
  assert.match(r.second.prompt, /- @critic’s choice “Which file name should the app use\?” \(in the thread “Release notes”, not on screen: open it\)/);
});

test('an ask left unanswered is handed back after each action that didn’t happen, once a step', async (t) => {
  const r = await onFakeClock(t, async () => {
    const run = stepLoop(heldRoom({ endAt: 600_000 }));
    const steps = [await run.next()];
    const actionError = run.holdFor({ type: 'next_phase' }, { waiting: steps[0].waiting, idle: false, phase: 0 });
    steps.push(await run.next({ lastAction: { type: 'next_phase' }, actionError }));
    // The tester’s answer then fails, as when it names an option the block doesn’t have: the ask still waits.
    steps.push(await run.next({ lastAction: { type: 'act', item: 'I4', choose: ['Yes — fix it'] }, actionError: 'No option “Yes — fix it”.' }));
    return steps;
  });
  assert.ok(r[2].at < 30_000, `three steps by ${r[2].at} ms, with the turn open until 600 s`);
  for (const [i, s] of r.entries()) {
    assert.equal(s.handed.length, 1, `step ${i + 1} had one hand-back: ${s.handed.join(' | ')}`);
    assert.equal(count(s.handed[0], WHAT), 1, `and it names the ask once: ${s.handed[0]}`);
    assert.equal(count(s.prompt, `- [I4] ${WHAT}`), 1, `as the list in step ${i + 1}’s prompt does`);
  }
});

test('a next_phase that goes ahead the second time leaves the ask waiting, and the wait is the turn’s', async (t) => {
  const r = await onFakeClock(t, async () => {
    const run = stepLoop(heldRoom({ endAt: 120_000 }));
    const first = await run.next();
    const at = { waiting: first.waiting, idle: false, phase: 0 };
    const held = run.holdFor({ type: 'next_phase' }, at);
    const second = await run.next({ lastAction: { type: 'next_phase' }, actionError: held });
    const again = run.holdFor({ type: 'next_phase' }, { ...at, waiting: second.waiting });
    return { again, third: await run.next({ lastAction: { type: 'next_phase' }, actionError: again }) };
  });
  assert.equal(r.again, null, 'the same again goes ahead');
  assert.ok(r.third.at >= 120_000, `the next step came when the turn ended (${r.third.at} ms)`);
  assert.deepEqual(r.third.handed, [], 'with no hand-back');
});

test('an ask that was answered isn’t handed back, though the action that answered it failed', async (t) => {
  const r = await onFakeClock(t, async () => {
    // The click lands a second after the hand-back at 12 s, and the action then fails: it reads as one that didn’t happen.
    const run = stepLoop(heldRoom({ endAt: 120_000, asks: [{ item: ASK, answeredAt: 13_000 }] }));
    const first = await run.next();
    return { first, second: await run.next({ lastAction: { type: 'act', item: 'I4' }, actionError: 'That block changed while you were deciding.' }) };
  });
  assert.ok(r.first.at < 13_000, `handed back at ${r.first.at} ms, before it was answered`);
  assert.deepEqual(r.second.handed, [], 'nothing was handed back');
  assert.ok(r.second.at >= 120_000, `the wait ran until the turn ended (${r.second.at} ms)`);
  assert.match(r.second.prompt, /Nothing is waiting on you\./);
});

test('of two asks, only the one still unanswered is handed back', async (t) => {
  const r = await onFakeClock(t, async () => {
    const run = stepLoop(heldRoom({ asks: [{ item: ASK, answeredAt: 13_000 }, { item: SECOND_ASK }] }));
    const first = await run.next();
    const actionError = run.holdFor({ type: 'next_phase' }, { waiting: first.waiting, idle: false, phase: 0 });
    const second = await run.next({ lastAction: { type: 'next_phase' }, actionError });
    return { first, second };
  });
  assert.equal(r.first.waiting.length, 2);
  assert.ok(r.second.at >= 13_000 && r.second.at - r.first.at < 5000, `the second step came at ${r.second.at} ms`);
  assert.deepEqual(r.second.handed, ['handed back again while @researcher works: @critic’s choice “Which file name should the app use?”']);
});

test('an ask the tester hasn’t had keeps its grace after a failed action', async (t) => {
  const r = await onFakeClock(t, async () => {
    // The first ask is answered as its action fails, and @critic’s is shown at 20 s, in a reply still being written.
    const asks = [
      { item: ASK, answeredAt: 13_000 },
      { item: SECOND_ASK, at: 20_000 },
    ];
    const run = stepLoop(heldRoom({ endAt: 120_000, asks }));
    await run.next();
    return run.next({ lastAction: { type: 'act', item: 'I4' }, actionError: 'That block changed while you were deciding.' });
  });
  assert.ok(r.at >= 20_000 + BLOCK_GRACE_MS && r.at < 20_000 + BLOCK_GRACE_MS + 3000, `handed back at ${r.at} ms`);
  assert.deepEqual(r.handed, ['handed back while @researcher works: @critic’s choice “Which file name should the app use?”']);
});

// #482: the hostwakes run of 27 October 2026 held four actions, and only run.log said so; its report’s timeline showed
// none of them, so a reader couldn’t tell a 120-second wait had been held while a card waited.
test('a held wait shows in the report’s timeline, with when and why it was held', async (t) => {
  const state = (await heldRoom({ endAt: 0 })()).state;
  const waiting = waitingList(state, THREADS, { labels: new Map([[ASK.id, 'I4']]), mainThread: 'th_main' });
  const timeline = [{ step: 7, phase: 'Leave the card', assessment: 'The card waits.', action: { type: 'wait', seconds: 120 } }];
  const at = Date.UTC(2026, 9, 27, 16, 57, 1);
  const holdFor = stepHolds({ goals: { leave: () => null }, log: () => {}, timeline, now: () => at });
  assert.ok(holdFor(timeline[0].action, { waiting, idle: true, phase: 0 }), 'the wait is held');
  assert.deepEqual(timeline[0].held, { at, why: `1 waiting on the person: [I4] ${WHAT}` });
  const dir = tempDir('uat-held-report-');
  t.mock.method(console, 'log', () => {});
  const facts = { streams: [], kiroStreams: [], agyStreams: [], state: null, probes: {}, samples: [] };
  await writeReport({ dir, scenario: { title: 'Host wakes' }, issues: [], findings: [], timeline, started: 0, tester: { spent: 0 }, facts, logLines: [] });
  const clock = new Date(at).toLocaleTimeString('en-US', { hour12: false });
  const md = readFileSync(join(dir, 'report.md'), 'utf8');
  assert.ok(
    md.includes(`7. **Leave the card.** The card waits. Next: \`{"type":"wait","seconds":120}\` **Held at ${clock}:** 1 waiting on the person: [I4] ${WHAT}.`),
    md,
  );
  assert.equal(
    JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8')).timeline[0].held.why.startsWith('1 waiting'),
    true,
    'and findings.json keeps it, for --recheck',
  );
});

test('each kind of hold is kept on its own step, and an action that goes ahead keeps none', () => {
  const timeline = /** @type {any[]} */ ([]);
  const leave = (/** @type {number} */ phase) => (phase === 1 ? 'Not yet: this phase’s triggers haven’t happened.' : null);
  const holdFor = stepHolds({ goals: { leave }, log: () => {}, timeline, now: () => 5 });
  const step = (/** @type {any} */ action, /** @type {any} */ at) => {
    timeline.push({ step: timeline.length + 1, phase: 'P', assessment: '', action });
    holdFor(action, at);
    return timeline.at(-1).held?.why ?? null;
  };
  assert.equal(step({ type: 'send', interrupt: { do: 'stop' } }, { waiting: [], idle: false, phase: 0 }), 'an interrupt while an agent works');
  assert.equal(step({ type: 'next_phase' }, { waiting: [], idle: true, phase: 1 }), 'the phase’s triggers haven’t happened');
  assert.equal(step({ type: 'send', text: 'hi' }, { waiting: [], idle: true, phase: 0 }), null);
});

test('stepHolds won’t start without the run’s timeline, where each hold is recorded (#482)', () => {
  assert.throws(() => stepHolds({ goals: { leave: () => null }, log: () => {} }), /needs the run’s timeline/);
});
