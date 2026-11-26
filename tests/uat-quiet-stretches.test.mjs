// #1746’s UAT readers (tools/uat/quiet-stretches.mjs, mid-turn-asks.mjs, idle-triggers.mjs, room-checks-idle.mjs) over
// five recorded runs’ events (tests/fixtures/uat/quiet-rooms.json says which, and how each was cut). No recorded run
// has the stall itself, 5 minutes idle with the nightly check unconfirmed: the longest quiet stretch with nothing
// pending is scifact’s 103 s, so the idle finding is tested there with its bar lowered, and at its real bar it must
// find nothing. tests/process/uat-nightly-log.test.mjs covers the nightly check’s own record.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runChecks } from '../tools/uat/checks.mjs';
import { handOffs, quietWhileWaiting } from '../tools/uat/idle-triggers.mjs';
import { midTurnAsks } from '../tools/uat/mid-turn-asks.mjs';
import { quietStretches } from '../tools/uat/quiet-stretches.mjs';
import { ASK_UNCOUNTED_MS, IDLE_MIN_MS, idleFindings, lengthOf, QUIET_LISTED_MS, uncountedAskFindings } from '../tools/uat/room-checks-idle.mjs';
import { TRIGGERS } from '../tools/uat/triggers.mjs';

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
  assert.deepEqual(s.what, ['@critic’s choice “Storage format for a year of click logs”', '@researcher’s choice “Partition the year of click logs by…”']);
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
  assert.equal(x.title, 'The room sat idle for 1 min 43 s with work waiting and nothing to restart it');
  assert.match(x.evidence, /for 1 min 43 s from 03:39:33 UTC: work waiting, with nothing to restart it; moved by the person’s message\./);
  assert.deepEqual(idleFindings(f, { min: 104_000, work }), [], 'a stretch under the bar is no finding');
  assert.deepEqual(idleFindings(f, { work }), [], `103 s is under the check’s own bar of ${lengthOf(IDLE_MIN_MS)}`);
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

test('a stretch counts only the conversations under test', () => {
  const thread = runs.addressed.events.find((/** @type {any} */ e) => e.type === 'item.add').data.threadId;
  assert.equal(long(quietStretches({ events: runs.addressed.events, threads: [thread] }, NO_WORK)).length, 1);
  assert.deepEqual(quietStretches({ events: runs.addressed.events, threads: ['th_other'] }, NO_WORK), []);
});

test('room-quiet-while-work-waited fires on a stretch that ended, of a minute or more, waiting on a wake or on nothing', () => {
  const { run, recorded } = TRIGGERS['room-quiet-while-work-waited'];
  assert.equal(recorded({ events: [] }), false);
  assert.deepEqual(run({ events: runs.addressed.events }), [
    { at: 1795471076170, evidence: 'Quiet for 2 min 37 s from 21:55:19 UTC, until @critic’s scheduled wake.' },
  ]);
  // Waiting on the person isn’t the stall this is there to reach, and neither is a room with no definition of done.
  assert.deepEqual(run({ events: runs.needsnav.events }), []);
  assert.deepEqual(run({ events: runs.scifact.events }), []);
  // The same room before the wake came: the stretch is still open, so the run hasn’t seen it end.
  const before = runs.addressed.events.filter((/** @type {any} */ e) => e.seq < 222);
  assert.deepEqual(run({ events: before }), []);
  // A wake that comes once the work has passed isn’t the room waiting on its work.
  const f = { events: runs.addressed.events };
  assert.equal(quietWhileWaiting(f, { asked: 0, queued: null, passed: null }).length, 1);
  assert.deepEqual(quietWhileWaiting(f, { asked: 0, queued: null, passed: { at: 1 } }), []);
});

test('work-handed-between-agents needs two hand-offs between three agents that a turn took, and no message from the person counts', () => {
  const { run } = TRIGGERS['work-handed-between-agents'];
  const f = { events: runs.holdstill.events };
  assert.deepEqual(handOffs(f).slice(0, 3), [
    { from: 'developer', to: 'critic', at: 1795459783677 },
    { from: 'developer', to: 'researcher', at: 1795459783677 },
    { from: 'critic', to: 'developer', at: 1795459789330 },
  ]);
  const [hit, ...rest] = run(f);
  assert.deepEqual(rest, []);
  assert.equal(hit.at, 1795459783677);
  assert.match(hit.evidence, /^5 hand-offs: @developer to @critic, @developer to @researcher, @critic to @developer, /);
  // Two agents asked by the person, each answering only the person: no hand-off, so a coverage gap.
  assert.deepEqual(handOffs({ events: runs.addressed.events }), []);
  assert.deepEqual(run({ events: runs.addressed.events }), []);
  // One hand-off isn’t a team at work: the same room up to the first message one agent’s turn took from another.
  const first = runs.holdstill.events.filter((/** @type {any} */ e) => e.seq <= 262);
  assert.deepEqual(handOffs({ events: first }), [{ from: 'developer', to: 'critic', at: 1795459783677 }]);
  assert.deepEqual(run({ events: first }), []);
  // …and two agents passing work back and forth aren’t three: the room’s entries without @researcher’s.
  const sessionOf = new Map(
    runs.holdstill.events.filter((/** @type {any} */ e) => e.type === 'session').map((/** @type {any} */ e) => [e.data.id, e.data.handle]),
  );
  const pair = runs.holdstill.events.filter(
    (/** @type {any} */ e) => e.type !== 'entry.add' || (e.data.entry.from !== 'researcher' && sessionOf.get(e.data.sessionId) !== 'researcher'),
  );
  assert.equal(handOffs({ events: pair }).length, 2);
  assert.deepEqual(run({ events: pair }), []);
  // A message that waits in an inbox and no turn takes isn’t work handed on.
  const untaken = runs.holdstill.events.filter((/** @type {any} */ e) => !(e.type === 'entry.patch' && e.data.patch.state === 'taken'));
  assert.deepEqual(handOffs({ events: untaken }), []);
});

test('an ask shown mid-turn is timed from when it showed to when its session named it, which on main is the turn’s end', () => {
  const [a, ...rest] = midTurnAsks({ events: runs.addressed.events });
  assert.deepEqual(rest, []);
  assert.deepEqual(a, {
    itemId: 'it_A7KpEE1Q',
    handle: 'researcher',
    title: 'Fix the load script?',
    shownAt: 1795470889059,
    turnMs: 4508,
    uncountedMs: 4508,
    counted: 'at-turn-end',
  });
  const f = { events: runs.addressed.events };
  const [x] = uncountedAskFindings(f, { min: 4000 });
  assert.equal(x.title, 'An ask shown mid-turn didn’t count as needing you for 5 s');
  assert.match(
    x.evidence,
    /^@researcher showed “Fix the load script\?” at 21:54:49 UTC and its turn ran 5 s more\. Its session first named it as what it needs when the turn ended\.$/,
  );
  assert.deepEqual(uncountedAskFindings(f, { min: 4600 }), []);
  assert.deepEqual(uncountedAskFindings(f), [], `4.5 s is under the check’s own bar of ${ASK_UNCOUNTED_MS / 1000} s`);
  // Three agents at work at once: each ask is timed by its own agent’s turn, not by the others’ events.
  assert.deepEqual(
    midTurnAsks({ events: runs.holdstill.events }).map((x) => [x.handle, x.title, x.turnMs, x.counted]),
    [
      ['critic', 'Draft: word-list app spec', 2632, 'never'],
      ['critic', 'Which file name should the app use?', 1994, 'at-turn-end'],
    ],
  );
  // The turn ended 4.5 s after the form, on a closing line: not an ask shown while its agent went on working.
  assert.deepEqual(TRIGGERS['ask-shown-mid-turn'].run(f), []);
});
