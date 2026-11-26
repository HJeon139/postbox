// A sprint room going quiet (tools/uat/room-checks-sprint.mjs, room-checks-idle.mjs, sprint-ceremonies.mjs, #1746): a
// standup as a round of answers, what each quiet minute came after, and the stall check as the runner runs it. The
// real board in a throwaway repository (tests/process/sprint-room.mjs), with the first paid run’s recorded turns for
// what a board doesn’t hold. It runs git and node, so it’s under tests/process/ (npm run test:process).

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardLog } from '../../tools/uat/board-log.mjs';
import { idleFindings } from '../../tools/uat/room-checks-idle.mjs';
import { afterCeremony } from '../../tools/uat/room-checks-sprint.mjs';
import { ceremonies } from '../../tools/uat/sprint-ceremonies.mjs';
import { TRIGGERS } from '../../tools/uat/triggers.mjs';
import { room, sprintOne, toSprintTwo } from './sprint-room.mjs';

const recorded = JSON.parse(readFileSync(new URL('../fixtures/uat/idleroom-2026-11-26.json', import.meta.url), 'utf8'));

test('a standup is a round of answers to the agent that asked, while a taken story isn’t done, and each quiet minute says what came before it', () => {
  // The real board’s lines, moved in time to sit inside the recorded sprint (the one edit to a record here): planning
  // and the three claims just before @developer’s round at 07:39:07, and the rest after the room’s 11 quiet minutes.
  // The recorded room is read without @alpha’s turns, as a team of three: with them no round’s answers all reached
  // the agent that asked (tests/uat-standup.test.mjs).
  const r = toSprintTwo(sprintOne());
  const lines = boardLog({ workspace: r.dir });
  const claimed = lines.findLastIndex((x) => x.did === 'claim');
  const moved = lines.map((x, i) => ({ ...x, at: (i <= claimed ? 1795678740000 : 1795679600000) + i }));
  writeFileSync(join(r.dir, '.git', 'board-log.jsonl'), moved.map((x) => `${JSON.stringify(x)}\n`).join(''));
  const events = recorded.events.filter((/** @type {any} */ e) => !(e.type === 'work.add' && e.data.entry.handle === 'alpha'));
  const f = { events, workspaceKept: r.dir, threads: [] };
  const [standup, ...more] = ceremonies(f).filter((c) => c.name === 'standup');
  assert.equal(
    standup.evidence,
    '@developer asked at 07:39:07 UTC, and @critic answered, @researcher answered. Not done then: S1 (@developer’s, open 8 s, 2 of its turns in), S2 (@critic’s, open 8 s, 1 of its turns in), S3 (@researcher’s, open 8 s, 1 of its turns in).',
  );
  assert.deepEqual(TRIGGERS['standup-round-held'].run(f)[0], { at: standup.at, evidence: standup.evidence });
  // @researcher’s round, twelve seconds on, is one too; the three rounds whose answers went elsewhere aren’t.
  assert.equal(more.length, 1);
  const [m] = afterCeremony(f, { asked: 1, queued: null, passed: null });
  assert.equal(m.title, 'What the sprint was doing each time the room went quiet');
  const [first, ...later] = m.evidence.split(' — ');
  assert.equal(later.length, 1, 'the four quiet minutes after the wake are the other');
  // A stretch the records can’t class isn’t listed: with no request to count from, only the wait on the wake is.
  assert.equal(afterCeremony(f, { asked: null, queued: null, passed: null })[0].evidence.split(' — ').length, 1);
  assert.match(
    first,
    /^Quiet for 10 min 48 s from 07:40:39 UTC: waiting on a scheduled wake \(@researcher’s wake due at 07:51:27 UTC\); moved by @researcher’s scheduled wake\. It came after a standup\. Not done in the sprint: S1 \(@developer’s\), S2 \(@critic’s\), S3 \(@researcher’s\)\. @developer’s last turn was woken by/,
  );
  assert.match(
    first,
    /@critic’s last turn was woken by @researcher’s reply that came back; it only wrote, reacted to what woke it; its reply reached no agent\./,
  );
  // The same room with its stories taken only after that round: a round, and no standup.
  writeFileSync(join(r.dir, '.git', 'board-log.jsonl'), lines.map((x, i) => `${JSON.stringify({ ...x, at: 1795679600000 + i })}\n`).join(''));
  assert.deepEqual(
    ceremonies(f).filter((c) => c.name === 'standup'),
    [],
  );
  // Nor is a round held once the sprint is planned and before anyone has taken a story: nothing is in progress yet.
  const plannedAt = lines.findIndex((x) => x.did === 'plan');
  const unclaimed = lines.map((x, i) => ({ ...x, at: (i <= plannedAt ? 1795678709000 : 1795679600000) + i }));
  writeFileSync(join(r.dir, '.git', 'board-log.jsonl'), unclaimed.map((x) => `${JSON.stringify(x)}\n`).join(''));
  assert.deepEqual(
    ceremonies(f).filter((c) => c.name === 'standup'),
    [],
  );
});

test('a run with no board has no sprint to read, and a sprint room that never used it says so', () => {
  const r = sprintOne();
  // A run with no board has no sprint to describe.
  assert.deepEqual(afterCeremony({ events: recorded.events, threads: [] }, { asked: 1, queued: null, passed: null }), []);
  assert.deepEqual(ceremonies({ events: recorded.events }), []);
  // A sprint room whose team never used the board says so, since its other findings rest on the board.
  const unused = room();
  unused.says('@alpha run it as scrum on the sprint board (node board.mjs help)');
  const [none] = afterCeremony(unused.facts());
  assert.equal(none.title, 'No board command was recorded in this run');
  assert.equal(none.verdict, 'measurement');
  assert.equal(
    boardLog({ workspace: join(r.dir, 'gone'), workspaceKept: r.dir }).length,
    boardLog({ workspace: r.dir }).length,
    'a recheck reads the kept workspace',
  );
});

test('idle-work-waiting, as the runner runs it, finds a sprint room that stopped, and none while it waits on its demo’s answer', () => {
  const r = sprintOne();
  /** @type {(state: string, at: number) => number} */
  const went = (state, at) => r.events.push({ type: 'session', data: { id: 'se_dev', handle: 'developer', threadId: 't', state, updatedAt: at } });
  /** The room’s facts, with its records ending so many minutes after a moment. @param {number} from @param {number} minutes */
  const f = (from, minutes) => ({ ...r.facts(), threads: [], until: from + minutes * 60_000 });
  const stopped = Date.now();
  went('think', stopped - 1);
  went('idle', stopped);
  assert.deepEqual(idleFindings(f(stopped, 4)), [], 'four minutes is under the bar');
  const [stall, ...more] = idleFindings(f(stopped, 6));
  assert.equal(stall.title, 'The room sat idle for 6 min 0 s with the sprint unfinished and nothing to restart it');
  assert.match(stall.evidence, /The board’s record never showed a second sprint with every story done: a team that kept the board by hand/);
  assert.deepEqual(more, []);
  // The same quiet after the demo is the customer’s to end.
  r.finish('developer', 'S1');
  r.as('alpha', 'demo', '1');
  const shown = Date.now();
  went('think', shown - 1);
  went('idle', shown);
  assert.deepEqual(idleFindings(f(shown, 6)), []);
});
