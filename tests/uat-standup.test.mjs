// The readers of turns and rounds (tools/uat/standup.mjs, #1746) over the first paid idleroom run’s records
// (tests/fixtures/uat/idleroom-2026-11-26.json says how it was cut): four agents on Claude Code, one pass of work, and
// 11 minutes quiet on one agent’s scheduled wake. A round is read by its shape, one agent’s turn that every other
// agent took a turn on, which that run has once: @alpha’s opening message. The same run tests the idle checks at
// their real bars, with the nightly check’s own record, and who ran a command, from its work ledger.
// tests/process/uat-sprint-board.test.mjs has the sprint’s ceremonies, on the real board.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { whoRan } from '../tools/uat/board-log.mjs';
import { dropUnverified, runChecks } from '../tools/uat/checks.mjs';
import { nightlyWork } from '../tools/uat/nightly-log.mjs';
import { quietStretches } from '../tools/uat/quiet-stretches.mjs';
import { idleFindings } from '../tools/uat/room-checks-idle.mjs';
import { lastTurns, STANDUP, standupRounds, turnsIn } from '../tools/uat/standup.mjs';
import { TRIGGERS } from '../tools/uat/triggers.mjs';
import { tempDir } from './temp-dirs.mjs';

const run = JSON.parse(readFileSync(new URL('./fixtures/uat/idleroom-2026-11-26.json', import.meta.url), 'utf8'));
/** The run’s facts as a recheck has them: its events, and its workspace with the nightly check’s record in it. */
function facts(events = run.events) {
  const workspaceKept = tempDir('uat-standup-');
  mkdirSync(join(workspaceKept, '.git'));
  writeFileSync(join(workspaceKept, '.git', 'nightly-log.jsonl'), run.nightly.map((/** @type {any} */ x) => `${JSON.stringify(x)}\n`).join(''));
  return { events, workspaceKept, threads: [] };
}
/** What @alpha’s opening message said, in place of “standup”: it named @developer, @critic and @researcher. */
const OPENED = /sprint is started/;
const QUIET_FROM = 1795678839700;

test('each turn is read with what woke it, the calls it made, its reaction and whom its replies reached', () => {
  const turns = turnsIn(run);
  assert.equal(turns.length, 52);
  const [first] = turns;
  assert.deepEqual(
    { handle: first.handle, woke: first.woke.map((w) => w.source), calls: first.calls, reacted: first.reacted, named: first.replies.map((r) => r.named) },
    { handle: 'alpha', woke: ['person'], calls: 2, reacted: true, named: [['developer', 'critic', 'researcher']] },
  );
  assert.match(first.replies[0].text, /^The sprint is started and @developer has the first step\./);
  // A turn that made no call and didn’t react, woken by a mention: @critic’s first.
  const critic = turns.find((t) => t.handle === 'critic');
  assert.deepEqual(
    { calls: critic?.calls, reacted: critic?.reacted, woke: critic?.woke },
    { calls: 0, reacted: false, woke: [{ source: 'mention', from: 'alpha', bounce: false, itemId: 'it_KxHjtswx' }] },
  );
  assert.equal(turns.filter((t) => t.reacted).length, 32);
});

test('a round is one agent’s turn and a turn from every other agent on it; the word “standup” is a hint, not the test', () => {
  const round = {
    by: 'alpha',
    at: 1795678710159,
    endedAt: 1795678730505,
    said: false,
    answers: [
      { handle: 'developer', wrote: true, at: 1795678730505 },
      { handle: 'critic', wrote: true, at: 1795678723707 },
      { handle: 'researcher', wrote: true, at: 1795678723294 },
    ],
  };
  // By shape, the recorded pass of work has one round, and nobody in it said “standup”.
  assert.deepEqual(standupRounds(run, { says: null }), [round]);
  assert.deepEqual(standupRounds(run), []);
  assert.deepEqual(standupRounds(run, { says: OPENED }), [round]);
  // A turn that reached two of the three isn’t a round: @alpha’s “@critic, step 2 is yours”, which woke @critic and @developer.
  assert.deepEqual(standupRounds(run, { says: /step 2 is yours/ }), []);
  // Nor is one whose agents haven’t each taken a turn on it yet: the room before @researcher’s first turn.
  const researcher = run.events.find((/** @type {any} */ e) => e.type === 'session' && e.data.handle === 'researcher').data.id;
  const took = run.events.find((/** @type {any} */ e) => e.type === 'entry.patch' && e.data.sessionId === researcher).seq;
  assert.deepEqual(standupRounds({ events: run.events.filter((/** @type {any} */ e) => e.seq < took) }, { says: null }), []);
  // A status round converges on whoever asked. The opening round’s answers went on to the next agent, none back to
  // @alpha, so it isn’t one; the same room without @alpha’s turns has five rounds by shape, and two whose answers
  // reached the agent that asked.
  assert.deepEqual(standupRounds(run, { says: null, toAsker: true }), []);
  const team = { events: run.events.filter((/** @type {any} */ e) => !(e.type === 'work.add' && e.data.entry.handle === 'alpha')) };
  assert.equal(standupRounds(team, { says: null }).length, 5);
  assert.deepEqual(
    standupRounds(team, { says: null, toAsker: true }).map((r) => [r.by, r.at, r.answers.map((a) => a.handle)]),
    [
      ['developer', 1795678747545, ['critic', 'researcher']],
      ['researcher', 1795678759829, ['developer', 'critic']],
    ],
  );
  // With no sprint board a round is no standup: the trigger wants a story someone had taken and not finished.
  assert.deepEqual(TRIGGERS['standup-round-held'].run(run), []);
  assert.equal(TRIGGERS['standup-round-held'].recorded({ workspace: 'a folder' }), true);
  assert.equal(TRIGGERS['standup-round-held'].recorded(run), false, 'facts with no workspace can’t say');
});

test('who ran a command is the agent whose shell command named the script, within two minutes before its record', () => {
  // The nightly check’s own record against the run’s work ledger: @researcher’s status found the pass, then @alpha’s did.
  assert.equal(whoRan(run, run.nightly[1].at, /nightly\.mjs/), 'researcher');
  assert.equal(whoRan(run, run.nightly[2].at, /nightly\.mjs/), 'alpha');
  // In the 11 quiet minutes nobody had run it for more than two.
  assert.equal(whoRan(run, 1795679300000, /nightly\.mjs/), null);
  // The run had no sprint board, so nobody ran one.
  assert.equal(whoRan(run, run.nightly[1].at), null);
  // Two commands in the window: the one whose text says what the record’s line did, else the newest. @alpha’s status
  // came 17 s after @researcher’s, and the third “passed” line is within two minutes of both.
  assert.equal(whoRan(run, run.nightly[2].at + 1000, /nightly\.mjs/), 'alpha');
  assert.equal(whoRan(run, run.nightly[2].at + 1000, /nightly\.mjs/, /date -u && node nightly/), 'researcher');
  assert.equal(whoRan(run, run.nightly[2].at + 1000, /nightly\.mjs/, /no such words/), 'alpha');
});

test('the words that make a message a standup', () => {
  for (const said of ['Standup time', 'Quick stand-up:', 'stand up, everyone', 'STANDUP']) assert.match(said, STANDUP);
  for (const said of ['an outstanding item', 'standups', 'the stand']) assert.doesNotMatch(said, STANDUP);
});

test('each agent’s last turn before a moment says what woke it, what it did and whom its reply reached', () => {
  assert.deepEqual(
    lastTurns(run, QUIET_FROM).map((t) => t.line),
    [
      '@alpha’s last turn was woken by @researcher’s mention; it only wrote, reacted to what woke it; its reply went back to @researcher.',
      '@developer’s last turn was woken by @researcher’s mention and @critic’s mention; it only wrote, reacted to what woke it; its reply went back to @researcher, @critic.',
      // The reaction ended the exchange: main’s rule for a reply that came back (#1553).
      '@critic’s last turn was woken by @researcher’s reply that came back; it only wrote, reacted to what woke it; its reply reached no agent.',
      '@researcher’s last turn was woken by @critic’s mention and @alpha’s reply that came back; it only wrote, reacted to what woke it; its reply went back to @critic.',
    ],
  );
  // The person’s message, calls made, and agents woken by name: the sprint’s first turn.
  assert.deepEqual(
    lastTurns(run, 1795678712000).map((t) => t.line),
    [
      '@alpha’s last turn was woken by the person’s message; it made 2 calls, reacted to what woke it; its reply woke @developer, @critic, @researcher by name.',
    ],
  );
  // A scheduled wake, and one call: @researcher’s turn that found the check had passed.
  const afterWake = lastTurns(run, 1795679530797).find((t) => t.handle === 'researcher');
  assert.equal(afterWake?.line, '@researcher’s last turn was woken by its scheduled wake; it made 1 call; its reply woke @alpha by name.');
});

test('a room waiting on the customer’s answer to a demo reads as waiting on the person, and a sprint’s stall says so', () => {
  const f = facts();
  const nightly = nightlyWork(f);
  // The recorded 11 quiet minutes, had a demo been shown just before them and not answered.
  const waiting = { ...nightly, customer: [{ from: QUIET_FROM - 1000, to: Number.POSITIVE_INFINITY, what: 'the customer’s answer to sprint 1’s demo' }] };
  const [s] = quietStretches(f, waiting).filter((x) => x.ms >= 60_000);
  assert.deepEqual([s.waiting, s.what], ['person', ['the customer’s answer to sprint 1’s demo']]);
  // Answered before the room went quiet, the demo is no longer what it waits on.
  const answered = { ...nightly, customer: [{ from: QUIET_FROM - 1000, to: QUIET_FROM - 1, what: 'the customer’s answer to sprint 1’s demo' }] };
  assert.equal(quietStretches(f, answered).filter((x) => x.ms >= 60_000)[0].waiting, 'scheduled');
  // Nor is a demo shown only after the room went quiet what that stretch waited on.
  const later = { ...nightly, customer: [{ from: QUIET_FROM + 1000, to: Number.POSITIVE_INFINITY, what: 'the customer’s answer to sprint 1’s demo' }] };
  assert.equal(quietStretches(f, later).filter((x) => x.ms >= 60_000)[0].waiting, 'scheduled');
  // The quiet 4 minutes after the work, had it been a sprint room with its second sprint unfinished: the stall, in a sprint’s words.
  const sprint = { asked: nightly.asked, queued: null, passed: null, customer: [] };
  const [x] = idleFindings(f, { min: 240_000, work: sprint });
  assert.equal(x.title, 'The room sat idle for 4 min 6 s with the sprint unfinished and nothing to restart it');
  assert.match(
    x.evidence,
    /moved by the person’s message\. The board’s record never showed a second sprint with every story done: .* reads the same\. The definition of done wasn’t met/,
  );
});

test('the run’s last pass decides after-ceremony too, which reads a stretch that may still be open', () => {
  const findings = new Map([['after-ceremony:after-ceremony', { source: 'check', check: 'after-ceremony' }]]);
  dropUnverified(findings);
  assert.equal(findings.size, 0);
});

test('the first paid idleroom run at the checks’ real bars: quiet on a scheduled wake, then done, and no finding', () => {
  const f = facts();
  const work = nightlyWork(f);
  assert.deepEqual(work, { asked: 1795678706682, queued: { at: 1795678754544, due: 1795679474544 }, passed: { at: 1795679491155 } });
  const quiet = quietStretches(f).filter((s) => s.ms >= 60_000);
  assert.deepEqual(
    quiet.map((s) => [s.ms, s.waiting, s.work, s.movedBy]),
    [
      [647_862, 'scheduled', 'waiting', '@researcher’s scheduled wake'],
      [246_157, 'done', 'done', 'the person’s message'],
    ],
  );
  assert.deepEqual(runChecks(f, { only: ['idle-work-waiting'] }), [], 'a wake was pending: the room wasn’t stalled');
  const [m] = runChecks(f, { only: ['quiet-stretches'] });
  assert.equal(m.title, 'The room was quiet for a minute or more 2 times');
  assert.ok(m.evidence.endsWith('The timed step was due at 07:51:14 UTC and first passed 17 s after that, at 07:51:31 UTC.'), m.evidence);
  assert.deepEqual(TRIGGERS['room-quiet-while-work-waited'].run(f), [
    { at: 1795679487562, evidence: 'Quiet for 10 min 48 s from 07:40:39 UTC, until @researcher’s scheduled wake.' },
  ]);
  assert.deepEqual(TRIGGERS['timed-step-queued'].run(f), [{ at: 1795678754544, evidence: 'Queued at 07:39:14 UTC, due at 07:51:14 UTC.' }]);
  assert.equal(TRIGGERS['work-handed-between-agents'].run(f).length, 1);
});
