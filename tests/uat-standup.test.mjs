// The standup readers (tools/uat/standup.mjs, room-checks-standup.mjs, #1746) over the first paid idleroom run’s
// records (tests/fixtures/uat/idleroom-2026-11-26.json says how it was cut): four agents on Claude Code, a sprint, and
// 11 minutes quiet on one agent’s scheduled wake. No recorded run has a standup by that word, so a round is found
// there by the words @alpha’s opening message did use, which named every other agent, and the trigger at its own
// word must find none. The same run tests the idle checks at their real bars, with the nightly check’s own record.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { dropUnverified, runChecks } from '../tools/uat/checks.mjs';
import { nightlyWork } from '../tools/uat/nightly-log.mjs';
import { quietStretches } from '../tools/uat/quiet-stretches.mjs';
import { afterStandup } from '../tools/uat/room-checks-standup.mjs';
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

test('a standup round is one agent’s turn that says so and names every other agent, with the turn each took for it', () => {
  assert.deepEqual(standupRounds(run), [], 'nobody in the recorded sprint said “standup”');
  assert.deepEqual(TRIGGERS['standup-round-held'].run(run), []);
  assert.equal(TRIGGERS['standup-round-held'].recorded(run), true);
  assert.equal(TRIGGERS['standup-round-held'].recorded({ events: [] }), false);
  assert.deepEqual(standupRounds(run, { says: OPENED }), [
    {
      by: 'alpha',
      at: 1795678710159,
      endedAt: 1795678730505,
      answers: [
        { handle: 'developer', wrote: true, at: 1795678730505 },
        { handle: 'critic', wrote: true, at: 1795678723707 },
        { handle: 'researcher', wrote: true, at: 1795678723294 },
      ],
    },
  ]);
  // A message that names two of the three isn’t a round: @alpha’s “@critic, step 2 is yours”, which named @critic and @developer.
  assert.deepEqual(standupRounds(run, { says: /step 2 is yours/ }), []);
  // Nor is one whose agents haven’t each taken a turn on it yet: the room before @researcher’s first turn.
  const researcher = run.events.find((/** @type {any} */ e) => e.type === 'session' && e.data.handle === 'researcher').data.id;
  const took = run.events.find((/** @type {any} */ e) => e.type === 'entry.patch' && e.data.sessionId === researcher).seq;
  assert.deepEqual(standupRounds({ events: run.events.filter((/** @type {any} */ e) => e.seq < took) }, { says: OPENED }), []);
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

test('after-standup says how the round went, what the room then waited on, and each agent’s last turn before it', () => {
  const f = facts();
  assert.deepEqual(afterStandup(f), [], 'no standup round, no measurement');
  assert.deepEqual(runChecks(f, { only: ['after-standup'] }), []);
  const [m, ...rest] = afterStandup(f, { says: OPENED });
  assert.deepEqual(rest, []);
  assert.equal(m.verdict, 'measurement');
  assert.equal(m.title, 'What each agent’s last turn did before the room went quiet after the standup');
  assert.ok(
    m.evidence.startsWith(
      '@alpha ran a standup at 07:38:30 UTC: 3 agents took a turn on it. Then the room was quiet for 10 min 48 s from 07:40:39 UTC: waiting on a scheduled wake (@researcher’s wake due at 07:51:27 UTC); moved by @researcher’s scheduled wake. @alpha’s last turn was woken by',
    ),
    m.evidence,
  );
  assert.ok(m.evidence.endsWith('its reply went back to @critic.'));
  // The room while the sprint still ran: a round, and no quiet minute after it yet.
  const during = facts(run.events.filter((/** @type {any} */ e) => e.seq < 1006));
  const [busy] = afterStandup(during, { says: OPENED });
  assert.equal(busy.title, 'A standup was held, and the room went on');
  assert.equal(busy.evidence, '@alpha ran a standup at 07:38:30 UTC: 3 agents took a turn on it. The room wasn’t quiet for a minute after it.');
});

test('the run’s last pass decides after-standup too, which reads a stretch that may still be open', () => {
  const findings = new Map([['after-standup:after-standup', { source: 'check', check: 'after-standup' }]]);
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
