// #1746’s UAT readers (tools/uat/quiet-stretches.mjs, mid-turn-asks.mjs, idle-triggers.mjs, room-checks-idle.mjs) over
// five recorded runs’ events (tests/fixtures/uat/quiet-rooms.json says which, and how each was cut). No recorded run
// has the stall itself, 5 minutes idle with the nightly check unconfirmed: the longest quiet stretch with nothing
// pending is scifact’s 103 s, so the idle finding is tested there with its bar lowered, and at its real bar it must
// find nothing. tests/process/uat-nightly-log.test.mjs covers the nightly check’s own record.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runChecks } from '../tools/uat/checks.mjs';
import { quietWhileWaiting } from '../tools/uat/idle-triggers.mjs';
import { quietStretches } from '../tools/uat/quiet-stretches.mjs';
import { runEnd, savedFacts } from '../tools/uat/recheck.mjs';
import { IDLE_MIN_MS, idleFindings, lengthOf, QUIET_LISTED_MS, quietMeasure, timedStepLine } from '../tools/uat/room-checks-idle.mjs';
import { tempDir } from './temp-dirs.mjs';

const { runs } = JSON.parse(readFileSync(new URL('./fixtures/uat/quiet-rooms.json', import.meta.url), 'utf8'));
/** A run with no definition of done in its records. */
const NO_WORK = { asked: null, queued: null, passed: null };
const long = (/** @type {any[]} */ stretches, min = 20_000) => stretches.filter((s) => s.ms >= min);

test('a room quiet until an agent’s own scheduled wake reads as waiting on that wake, and says the wake moved it', () => {
  const [s, ...rest] = long(quietStretches({ events: runs.addressed.events }, NO_WORK));
  assert.deepEqual(rest, []);
  assert.deepEqual(
    { ms: s.ms, waiting: s.waiting, what: s.what, open: s.open, movedBy: s.movedBy, overdueMs: s.overdueMs },
    {
      ms: 156_640,
      waiting: 'scheduled',
      what: ['@critic’s wake due at 21:57:56 UTC'],
      open: false,
      movedBy: '@critic’s scheduled wake',
      overdueMs: null,
    },
  );
  // It started when the last agent’s turn ended, not at the wake’s own item, which carries the time it’s due.
  assert.equal(s.from, 1795470919530);
  // Once the wake has run it waits on nothing: the room after @critic’s reply has no wake pending.
  const after = quietStretches({ events: runs.addressed.events }, NO_WORK).at(-1);
  assert.deepEqual({ open: after?.open, waiting: after?.waiting, what: after?.what }, { open: true, waiting: 'unknown', what: [] });
});

test('a room quiet with choices open reads as waiting on the person, names them, and says their answer moved it', () => {
  const [s] = long(quietStretches({ events: runs.needsnav.events }, NO_WORK));
  assert.equal(s.ms, 52_317);
  assert.equal(s.waiting, 'person');
  assert.deepEqual(s.what, ['@researcher’s choice “Partition the year of click logs by…”', '@critic’s choice “Storage format for a year of click logs”']);
  assert.equal(s.movedBy, 'the person’s answer');
});

test('a room quiet on a permission card reads as waiting on the person from the session’s need alone, on a four-backend run', () => {
  const [s, ...rest] = long(quietStretches({ events: runs.inboxroom.events }, NO_WORK));
  assert.deepEqual(rest, []);
  assert.deepEqual(
    { ms: s.ms, waiting: s.waiting, what: s.what, movedBy: s.movedBy },
    { ms: 62_623, waiting: 'person', what: ['@developer’s permission'], movedBy: 'the person’s message' },
  );
});

test('each stretch says what moved the room: the person’s message or answer, a scheduled wake, or the turn that started with no item first', () => {
  const moved = quietStretches({ events: runs.addressed.events }, NO_WORK).map((s) => s.movedBy);
  assert.deepEqual(moved, [
    '@critic’s turn, for its newest entry (person)',
    'the person’s message',
    '@researcher’s turn, for its newest entry (person)',
    'the person’s message',
    '@researcher’s turn, for its newest entry (person)',
    // Postbox’s own check of the reply woke @researcher, with no item first.
    '@researcher’s turn, for its newest entry (check)',
    'the person’s answer',
    '@researcher’s turn, for its newest entry (answer)',
    'the person’s message',
    '@researcher’s turn, for its newest entry (person)',
    '@critic’s scheduled wake',
    '@critic’s turn, for its newest entry (scheduled)',
    null,
  ]);
  // A run from before the runner kept the inboxes’ entries says so, rather than naming none.
  assert.equal(quietStretches({ events: runs.inboxroom.events }, NO_WORK)[0].movedBy, '@researcher’s turn, for its newest entry (none recorded)');
});

test('a quiet room with nothing pending is “nothing to restart it” while the work waits, “done” once it passed, and “unknown” with no definition of done', () => {
  const f = { events: runs.scifact.events };
  const asked = f.events.find((/** @type {any} */ e) => e.type === 'item.add' && e.data.item.kind === 'user').data.item.at;
  const { earlier, lastBeforeQuiet } = runs.scifact.shell;
  const only = (/** @type {any} */ work) => {
    const found = long(quietStretches(f, work));
    assert.equal(found.length, 1);
    return found[0];
  };
  assert.equal(only(NO_WORK).waiting, 'unknown');
  // A turn’s shell calls, 27 of them here and some over 10 s, are the agent working, not the room quiet.
  assert.equal(quietStretches(f, NO_WORK).length, 4);
  const waiting = only({ asked, queued: null, passed: null });
  assert.equal(waiting.waiting, 'nothing');
  assert.equal(waiting.ms, 103_207);
  assert.equal(waiting.movedBy, 'the person’s message');
  assert.equal(waiting.overdueMs, null, 'no timed step was queued, so nothing was overdue');
  assert.equal(only({ asked, queued: null, passed: { at: lastBeforeQuiet } }).waiting, 'done');
  // A pass that came after the stretch began didn’t make the room done while it was quiet.
  assert.equal(only({ asked, queued: null, passed: { at: waiting.from + 1 } }).waiting, 'nothing');
  // A request that came after the stretch can’t have been waiting through it.
  assert.equal(only({ asked: waiting.to + 1, queued: null, passed: null }).waiting, 'unknown');
  // A timed step due 60 s after it was queued: the stretch counts only what came after that.
  const due = earlier + 60_000;
  assert.equal(only({ asked, queued: { at: earlier, due }, passed: null }).overdueMs, waiting.to - due);
  assert.equal(only({ asked, queued: { at: earlier, due: waiting.from - 1 }, passed: null }).overdueMs, waiting.ms);
  // Nothing is overdue in a room whose work is done, or for a step queued only after the stretch.
  assert.equal(only({ asked, queued: { at: earlier, due }, passed: { at: lastBeforeQuiet } }).overdueMs, null);
  assert.equal(only({ asked, queued: { at: waiting.to + 1, due: waiting.to + 2 }, passed: null }).overdueMs, null);
});

test('idle-work-waiting finds the stretch at a bar it passes, with its length and what moved the room, and nothing at its real bar or once the work passed', () => {
  const f = { events: runs.scifact.events };
  const asked = f.events.find((/** @type {any} */ e) => e.type === 'item.add' && e.data.item.kind === 'user').data.item.at;
  const work = { asked, queued: null, passed: null };
  const [x, ...rest] = idleFindings(f, { min: 100_000, work });
  assert.deepEqual(rest, []);
  assert.equal(x.title, 'The room sat idle for 1 min 43 s with work waiting, the timed step not yet queued and nothing to restart it');
  assert.match(
    x.evidence,
    /for 1 min 43 s from 03:39:33 UTC: work waiting, with nothing to restart it; moved by the person’s message\. Nobody had queued the timed step yet/,
  );
  assert.deepEqual(idleFindings(f, { min: 104_000, work }), [], 'a stretch under the bar is no finding');
  assert.equal(IDLE_MIN_MS, 5 * 60_000);
  assert.deepEqual(idleFindings(f, { work }), [], `103 s is under the check’s own bar of ${lengthOf(IDLE_MIN_MS)}`);
  // With a timed step queued, the bar counts from when it was due: here 79 s of the 103, the step due 60 s after a
  // recorded shell result. Waiting a step out isn’t idling, and the finding says the step had been queued.
  const { earlier } = runs.scifact.shell;
  const timed = { ...work, queued: { at: earlier, due: earlier + 60_000 } };
  const [late] = idleFindings(f, { min: 79_000, work: timed });
  assert.equal(late.title, 'The room sat idle for 1 min 19 s after the timed step was due, with nothing to restart it');
  assert.match(
    late.evidence,
    /1 min 19 s of it after the timed step was due; moved by the person’s message\. The timed step had been queued, and nothing told/,
  );
  assert.deepEqual(idleFindings(f, { min: 80_000, work: timed }), [], 'the 24 s before it was due don’t count');
  assert.deepEqual(idleFindings(f, { min: 100_000, work: { ...work, passed: { at: runs.scifact.shell.lastBeforeQuiet } } }), []);
  // Waiting on a scheduled wake or on the person is never this finding, however long: 157 s and 52 s here.
  assert.deepEqual(idleFindings({ events: runs.addressed.events }, { min: 1000, work: { asked: 0, queued: null, passed: null } }), []);
  assert.deepEqual(long(idleFindings({ events: runs.needsnav.events }, { min: 20_000, work: { asked: 0, queued: null, passed: null } })), []);
});

test('no run without the scenario’s request gets an idle finding from the checks as the runner runs them', () => {
  for (const [name, run] of Object.entries(runs)) {
    const found = runChecks({ events: /** @type {any} */ (run).events, threads: [] }, { only: ['idle-work-waiting', 'ask-uncounted-mid-turn'] });
    assert.deepEqual(found, [], name);
  }
});

test('quiet-stretches lists the stretches of a minute or more as one measurement, and none it can’t classify', () => {
  const [m, ...rest] = runChecks({ events: runs.addressed.events, threads: [] }, { only: ['quiet-stretches'] });
  assert.deepEqual(rest, []);
  assert.equal(m.verdict, 'measurement');
  assert.equal(m.issue, null);
  assert.equal(m.title, 'The room was quiet for a minute or more once');
  assert.equal(
    m.evidence,
    '2 min 37 s from 21:55:19 UTC: waiting on a scheduled wake (@critic’s wake due at 21:57:56 UTC); moved by @critic’s scheduled wake.',
  );
  assert.equal(QUIET_LISTED_MS, 60_000);
  // needsnav’s longest is 52 s, and scifact’s 103 s has no definition of done to be judged by.
  assert.deepEqual(runChecks({ events: runs.needsnav.events, threads: [] }, { only: ['quiet-stretches'] }), []);
  assert.deepEqual(runChecks({ events: runs.scifact.events, threads: [] }, { only: ['quiet-stretches'] }), []);
});

test('the measurement says how long after the timed step was due the room knew it had passed, the number to compare runs by', () => {
  const { earlier, lastBeforeQuiet } = runs.scifact.shell;
  const f = { events: runs.scifact.events };
  const asked = f.events.find((/** @type {any} */ e) => e.type === 'item.add' && e.data.item.kind === 'user').data.item.at;
  // Queued and due at two recorded shell results’ times, and passed when the person’s next message came.
  const queued = { at: earlier, due: lastBeforeQuiet };
  const back = 1793936476438;
  assert.equal(
    timedStepLine({ asked, queued, passed: { at: back } }),
    'The timed step was due at 03:39:23 UTC and first passed 1 min 53 s after that, at 03:41:16 UTC.',
  );
  assert.equal(timedStepLine({ asked, queued, passed: null }), 'The timed step was due at 03:39:23 UTC and hadn’t passed when the records end.');
  assert.equal(timedStepLine({ asked, queued: null, passed: null }), '');
  // A room with a timed step and no quiet minute still gets its line: three agents at work, the step’s times two of
  // their recorded hand-offs’.
  const [busy] = quietMeasure({ events: runs.holdstill.events }, { asked: 0, queued: { at: 1795459783677, due: 1795459789330 }, passed: null });
  assert.equal(busy.title, 'The timed step’s times');
  assert.equal(busy.evidence, 'The timed step was due at 18:49:49 UTC and hadn’t passed when the records end.');
  const [m] = quietMeasure(f, { asked, queued, passed: { at: back } });
  assert.equal(
    m.evidence,
    '1 min 43 s from 03:39:33 UTC: work waiting, with nothing to restart it, 1 min 43 s of it after the timed step was due; moved by the person’s message. The timed step was due at 03:39:23 UTC and first passed 1 min 53 s after that, at 03:41:16 UTC.',
  );
});

test('a room still quiet when the records end is quiet until the run’s own clock, not for no time at all', () => {
  // The room before @critic’s wake came, read as the runner reads it mid-wait and as a run cut there would leave it.
  const before = runs.addressed.events.filter((/** @type {any} */ e) => e.seq < 222);
  const wakeAt = 1795471076170;
  const open = quietStretches({ events: before, until: wakeAt }, NO_WORK).at(-1);
  assert.deepEqual(
    { ms: open?.ms, open: open?.open, waiting: open?.waiting, movedBy: open?.movedBy },
    { ms: 156_640, open: true, waiting: 'scheduled', movedBy: null },
  );
  assert.equal(quietStretches({ events: before }, NO_WORK).at(-1)?.ms, 0, 'facts with no clock can’t say how long');
  // A clock behind the last record doesn’t shorten what the records show.
  assert.equal(quietStretches({ events: before, until: 1 }, NO_WORK).at(-1)?.ms, 0);
  // A room cut while idle with work waiting is the finding, though nothing moved it…
  const cut = runs.scifact.events.filter((/** @type {any} */ e) => e.seq < 692);
  const asked = cut.find((/** @type {any} */ e) => e.type === 'item.add' && e.data.item.kind === 'user').data.item.at;
  const [x] = idleFindings({ events: cut, until: 1793936476438 }, { min: 100_000, work: { asked, queued: null, passed: null } });
  assert.match(x.evidence, /for 1 min 43 s from 03:39:33 UTC: work waiting, with nothing to restart it; still quiet when the records end\./);
  // …but it isn’t yet a stretch that ended, which the phase’s trigger waits for.
  assert.deepEqual(quietWhileWaiting({ events: before, until: wakeAt }, NO_WORK), []);
});

test('a stretch counts only the conversations under test', () => {
  const thread = runs.addressed.events.find((/** @type {any} */ e) => e.type === 'item.add').data.threadId;
  assert.equal(long(quietStretches({ events: runs.addressed.events, threads: [thread] }, NO_WORK)).length, 1);
  assert.deepEqual(quietStretches({ events: runs.addressed.events, threads: ['th_other'] }, NO_WORK), []);
});

test('a recheck’s facts carry the run’s end as its clock, and the workspace the run kept', () => {
  // The 25 November profile run: when it started (findings.json) and how long it took (run.json’s timing).
  const saved = { started: 1795643147342 };
  const record = { timing: { totalMs: 100_710 } };
  assert.equal(runEnd(saved, record), 1795643248052);
  assert.equal(runEnd(saved, null), null, 'a run from before timing was kept has no end to give');
  assert.equal(runEnd({}, record), null);
  const dir = tempDir('uat-idle-recheck-');
  const facts = savedFacts(dir, { state: { threads: {} }, mainId: 't1', saved, logs: [], hostsRec: null, record });
  assert.equal(facts.until, 1795643248052);
  assert.equal(facts.workspaceKept, `${dir}/workspace`);
});
