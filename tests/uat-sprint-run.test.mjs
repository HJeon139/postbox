// The sprint readers over the first paid run of the sprint idleroom (tests/fixtures/uat/idleroom-sprint-2026-11-26.jsonl
// says how it was cut: its events to just past the customer’s answer, and its board record whole): four agents on
// Claude Code, three sprints in 11 minutes. It is the run that showed the sprint was too small (#1784): every story
// was done seconds after it was taken, so no standup landed on open work. Real board commands, with the real ledger
// lines for who ran them.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardLog } from '../tools/uat/board-log.mjs';
import { runChecks } from '../tools/uat/checks.mjs';
import { storySizeMeasure } from '../tools/uat/room-checks-sprint.mjs';
import { ceremonies } from '../tools/uat/sprint-ceremonies.mjs';
import { standupRounds } from '../tools/uat/standup.mjs';
import { openAt, storySizes } from '../tools/uat/story-sizes.mjs';
import { TRIGGERS } from '../tools/uat/triggers.mjs';
import { tempDir } from './temp-dirs.mjs';

const [head, ...events] = readFileSync(new URL('./fixtures/uat/idleroom-sprint-2026-11-26.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
/** The run’s facts as a recheck has them: its events, and its workspace with the board’s record in it. */
function facts() {
  const workspaceKept = tempDir('uat-sprint-run-');
  mkdirSync(join(workspaceKept, '.git'));
  writeFileSync(join(workspaceKept, '.git', 'board-log.jsonl'), head.board.map((/** @type {any} */ x) => `${JSON.stringify(x)}\n`).join(''));
  return { events, workspaceKept, threads: [] };
}
const fired = (/** @type {any} */ f, /** @type {string} */ id) => TRIGGERS[id].run(f).map((x) => x.evidence);

test('the run’s ceremonies read from its board and its ledger: who estimated and who took a story are who ran the commands', () => {
  const f = facts();
  assert.equal(boardLog(f).length, 69);
  assert.deepEqual(
    ceremonies(f).map((c) => `${c.name}${c.sprint ?? ''}`),
    [
      'groomed',
      'estimated',
      'planned1',
      'elected1',
      'planned1',
      'demo1',
      'retro1',
      'planned2',
      'elected2',
      'demo-answered1',
      'sent-back1',
      'planned3',
      'took-actions3',
    ],
  );
  // Three agents each ran the same six estimates within three seconds: each is credited with their own.
  assert.deepEqual(fired(f, 'stories-estimated'), ['@developer, @critic, @researcher each gave estimates before the first sprint.']);
  assert.deepEqual(fired(f, 'tasks-elected').slice(0, 1), ['@developer, @researcher, @critic each took a story of sprint 1 themselves.']);
  assert.deepEqual(fired(f, 'backlog-groomed'), [
    '6 stories in the backlog, and 7 changes to it (ordered, split, clarified or tied to another) before the first sprint.',
  ]);
  assert.match(fired(f, 'sprint-planned')[0], /^Sprint 1 took 3 of the board’s 6 stories\. Goal: A title turns into a clean, lowercase, hyphenated slug/);
  assert.deepEqual(fired(f, 'demo-shown'), ['Sprint 1’s stories were listed for the customer at 09:40:59 UTC, with one or more done.']);
  assert.deepEqual(fired(f, 'demo-answered'), ['The person answered sprint 1’s demo at 09:42:44 UTC.']);
  assert.deepEqual(fired(f, 'story-sent-back'), ['S1 went back to the backlog after the customer’s answer.']);
  assert.deepEqual(fired(f, 'retro-held'), ['3 action items after sprint 1’s demo: A3, A4, A5.']);
  assert.deepEqual(fired(f, 'next-sprint-took-actions'), ['Sprint 3’s plan took A1, A2 and S1, which the customer had sent back.']);
});

test('every story was done within 30 seconds of being taken, most in the turn that took it', () => {
  const f = facts();
  const sizes = storySizes(f, boardLog(f));
  assert.deepEqual(
    sizes.map((s) => [s.story, s.owner, s.doneAt === null ? null : Math.round((s.doneAt - s.at) / 1000), s.turns, s.reviewedBy]),
    [
      ['S1', 'developer', 6, 1, null],
      ['S3', 'researcher', 18, 2, null],
      ['S2', 'critic', 5, 1, null],
      // Sent back within the sprint and taken again: each time a story is taken is its own.
      ['S3', 'researcher', 0, 1, null],
      ['S6', 'developer', 7, 1, null],
      ['S5', 'researcher', 6, 1, null],
      ['S4', 'critic', 30, 2, null],
      ['S1', 'developer', 7, 1, null],
    ],
  );
  const [m, ...rest] = storySizeMeasure(f);
  assert.deepEqual(rest, []);
  assert.equal(m.title, '2 of 8 stories were open across more than one of their owner’s turns');
  assert.equal(m.verdict, 'measurement');
  assert.ok(
    m.evidence.startsWith('S1, @developer’s: open 6 s over 1 of its turns, not reviewed. S3, @researcher’s: open 18 s over 2 of its turns, not reviewed.'),
    m.evidence,
  );
  assert.deepEqual(runChecks(f, { only: ['story-sizes'] })[0].title, m.title);
  // A run with no story taken on a board has no sizes to give.
  assert.deepEqual(storySizeMeasure({ events, threads: [] }), []);
});

test('so no standup could land on open work: the run has rounds, and no story someone had taken was open at any', () => {
  const f = facts();
  // By shape, four rounds, two of them with every answer reaching the agent that asked.
  assert.equal(standupRounds(f, { says: null }).length, 4);
  const rounds = standupRounds(f, { says: null, toAsker: true });
  assert.equal(rounds.length, 2);
  const log = boardLog(f);
  for (const r of rounds) assert.deepEqual(openAt(f, log, r.at), [], `nothing was open at ${r.at}`);
  assert.deepEqual(fired(f, 'standup-round-held'), []);
  // While @critic had S4, 20 of its 30 seconds in: one story open, still in the turn that took it.
  const taken = log.find((x) => x.did === 'claim' && x.story === 'S4').at;
  assert.deepEqual(
    openAt(f, log, taken + 20_000).map((s) => [s.story, s.owner, s.ms, s.turns]),
    [['S4', 'critic', 20_000, 1]],
  );
  // The sprint finished and the room never stalled: nothing to find, and no quiet minute to list before the answer.
  assert.deepEqual(runChecks(f, { only: ['idle-work-waiting', 'quiet-stretches', 'after-ceremony'] }), []);
});
