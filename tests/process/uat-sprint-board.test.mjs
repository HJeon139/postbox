// The idleroom scenarios’ sprint board (tests/uat/e2e/fixtures/sprint/board.mjs, #1746) and what the UAT reads of it
// (tools/uat/board-log.mjs, sprint-ceremonies.mjs, sprint-triggers.mjs, room-checks-sprint.mjs): the real tool in a
// throwaway repository, driven through two sprints as a team would drive it. It runs git and node, so it’s under
// tests/process/ (npm run test:process). No run has used the board yet, so who ran each command comes from ledger
// lines this test writes in the shape the recorded runs have (tests/fixtures/uat/idleroom-2026-11-26.json), one per
// command it runs; whoRan itself is tested on that run’s real ledger (tests/uat-standup.test.mjs).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boardAt, boardLog, openStories, sprintWork, workOf } from '../../tools/uat/board-log.mjs';
import { afterCeremony } from '../../tools/uat/room-checks-sprint.mjs';
import { ceremonies } from '../../tools/uat/sprint-ceremonies.mjs';
import { TRIGGERS } from '../../tools/uat/triggers.mjs';

const FIXTURE = fileURLToPath(new URL('../uat/e2e/fixtures/sprint', import.meta.url));
const recorded = JSON.parse(readFileSync(new URL('../fixtures/uat/idleroom-2026-11-26.json', import.meta.url), 'utf8'));
const home = mkdtempSync(join(tmpdir(), 'pb-test-board-'));
after(() => rmSync(home, { recursive: true, force: true }));

/** A sprint room’s workspace and the events its commands leave: `as` runs the board as an agent, `says` is the person. */
function room() {
  const dir = mkdtempSync(join(home, 'workspace-'));
  spawnSync('git', ['init', '-q'], { cwd: dir, timeout: 30_000 });
  cpSync(FIXTURE, dir, { recursive: true });
  /** @type {any[]} */
  const events = [];
  const as = (/** @type {string} */ handle, /** @type {string[]} */ ...args) => {
    events.push({ type: 'work.add', data: { entry: { kind: 'command', handle, startedAt: Date.now(), command: `node board.mjs ${args.join(' ')}` } } });
    const r = spawnSync(process.execPath, ['board.mjs', ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    return { said: r.stdout.trim(), code: r.status };
  };
  const says = (/** @type {string} */ text) =>
    events.push({ type: 'item.add', data: { threadId: 't', item: { id: `it_${events.length}`, at: Date.now(), kind: 'user', text } } });
  return { dir, events, as, says, facts: () => ({ events, workspace: dir }) };
}

/** Sprint 1 up to its demo: six stories groomed, sized by two of the team, three taken, each by its own agent, all done. */
function sprintOne(r = room(), { sizers = ['developer', 'critic'], takers = ['developer', 'critic', 'researcher'], taken = ['S1', 'S2', 'S3'] } = {}) {
  r.says('@alpha run it as scrum on the sprint board (node board.mjs help)');
  for (const story of ['lowercase', 'no stray hyphens', 'untitled', 'forty characters', 'digits', 'a command']) r.as('alpha', 'add', story);
  r.as('alpha', 'order', 'S1', 'S2', 'S3');
  r.as('alpha', 'clarify', 'S3', 'an empty title gives untitled');
  for (const who of sizers) r.as(who, 'estimate', 'S1', '2');
  r.as('alpha', 'plan', '1', 'a usable slug', ...taken);
  taken.forEach((id, i) => {
    if (takers[i]) r.as(takers[i], 'claim', id, takers[i]);
  });
  return r;
}

/** From sprint 1’s work to sprint 2’s plan: the stories done, the demo and the customer’s answer, a story sent back, an action item. */
function toSprintTwo(/** @type {ReturnType<typeof room>} */ r) {
  for (const [who, id] of [
    ['developer', 'S1'],
    ['critic', 'S2'],
    ['researcher', 'S3'],
  ])
    r.as(who, 'done', id);
  r.as('alpha', 'demo', '1');
  r.says('Demo: I accept the sprint, except the story about lowercase words: it must also drop accents.');
  r.as('alpha', 'return', 'S1', 'must drop accents');
  r.as('alpha', 'action', 'agree the acceptance with the customer before building');
  r.as('alpha', 'plan', '2', 'accents, and the length', 'S1', 'S4', 'A1');
  return r;
}

test('the board refuses what it can’t do, says why, and records nothing of it', () => {
  const r = room();
  assert.match(r.as('alpha', 'help').said, /^node board\.mjs <command>/);
  assert.deepEqual(r.as('alpha', 'claim', 'S1', 'developer'), { said: 'Not done: There’s no story S1. The board has: none yet.', code: 1 });
  assert.equal(r.as('alpha', 'add', 'lowercase').said, 'S1: lowercase');
  assert.match(r.as('developer', 'done', 'S1').said, /^Not done: Nobody has taken S1/);
  assert.match(r.as('developer', 'estimate', 'S1', 'big').said, /^Not done: estimate takes a story and a number of points/);
  assert.deepEqual(
    boardLog({ workspace: r.dir }).map((x) => x.did),
    ['add'],
  );
  assert.match(readFileSync(join(r.dir, 'BOARD.md'), 'utf8'), /\| S1 \| lowercase \| {2}\| {2}\| {2}\| backlog \|/);
});

test('six of the team adding a story in the same moment each get one: no change to the board is lost', async () => {
  const r = room();
  const add = (/** @type {number} */ n) =>
    new Promise((done) => spawn(process.execPath, ['board.mjs', 'add', `story ${n}`], { cwd: r.dir, timeout: 30_000 }).on('close', done));
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5, 6].map(add)), [0, 0, 0, 0, 0, 0]);
  const added = boardLog({ workspace: r.dir }).map((x) => x.story);
  assert.deepEqual([...added].sort(), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  assert.equal(readFileSync(join(r.dir, 'BOARD.md'), 'utf8').match(/\| story \d \|/g)?.length, 6);
});

test('two sprints through the real board leave every ceremony in its record, and each trigger reads its own', () => {
  const r = sprintOne();
  const f = r.facts;
  const held = () => ceremonies(f()).map((c) => c.name);
  assert.deepEqual(held(), ['groomed', 'estimated', 'planned', 'elected']);
  assert.deepEqual(
    openStories(boardLog(f()), Date.now()).map((s) => [s.id, s.owner]),
    [
      ['S1', 'developer'],
      ['S2', 'critic'],
      ['S3', 'researcher'],
    ],
  );
  for (const [who, id] of [
    ['developer', 'S1'],
    ['critic', 'S2'],
    ['researcher', 'S3'],
  ])
    r.as(who, 'done', id);
  assert.equal(r.as('alpha', 'demo', '1').said, 'S1 lowercase: done\nS2 no stray hyphens: done\nS3 untitled: done');
  assert.equal(sprintWork(f()).customer?.[0].to, Number.POSITIVE_INFINITY, 'the demo waits on the customer until they answer');
  r.says('Demo: I accept the sprint, except the story about lowercase words: it must also drop accents.');
  r.as('alpha', 'return', 'S1', 'must drop accents');
  assert.equal(
    r.as('alpha', 'action', 'agree the acceptance with the customer before building').said,
    'A1: agree the acceptance with the customer before building',
  );
  r.as('alpha', 'plan', '2', 'accents, and the length', 'S1', 'S4', 'A1');
  assert.deepEqual(held(), ['groomed', 'estimated', 'planned', 'elected', 'demo', 'demo-answered', 'sent-back', 'retro', 'planned', 'took-actions']);
  const fired = (/** @type {string} */ id) => TRIGGERS[id].run(f()).length;
  for (const id of [
    'backlog-groomed',
    'stories-estimated',
    'sprint-planned',
    'tasks-elected',
    'demo-shown',
    'demo-answered',
    'story-sent-back',
    'retro-held',
    'next-sprint-took-actions',
  ])
    assert.equal(fired(id), 1, id);
  assert.equal(fired('standup-round-held'), 0, 'a standup is turns, and this room has none');
  assert.match(TRIGGERS['sprint-planned'].run(f())[0].evidence, /^Sprint 1 took 3 of the board’s 6 stories\. Goal: a usable slug$/);
  assert.match(TRIGGERS['tasks-elected'].run(f())[0].evidence, /^@developer, @critic, @researcher each took a story of sprint 1 themselves\.$/);
  assert.match(TRIGGERS['next-sprint-took-actions'].run(f())[0].evidence, /took A1 and S1, which the customer had sent back/);
});

test('work is waiting from the person’s request until sprint 2’s stories are all done, and on the customer from the demo to their answer', () => {
  const r = toSprintTwo(sprintOne());
  const f = r.facts;
  // Work is waiting from the person’s request until sprint 2’s stories are all done, and on the customer from the demo to their answer.
  const work = () => sprintWork(f());
  assert.equal(work().passed, null);
  assert.equal(work().asked, r.events[0].data.item.at);
  const [customer] = work().customer ?? [];
  assert.ok(customer.to > customer.from && customer.to < Date.now(), 'the answer closed the wait');
  assert.equal(customer.what, 'the customer’s answer to sprint 1’s demo');
  r.as('developer', 'claim', 'S1', 'developer');
  r.as('critic', 'claim', 'S4', 'critic');
  r.as('developer', 'done', 'S1');
  assert.equal(work().passed, null, 'one of sprint 2’s stories is still open');
  r.as('critic', 'done', 'S4');
  const log = boardLog(f());
  assert.deepEqual(work().passed, { at: log.at(-1).at });
  assert.deepEqual(workOf(f()), work(), 'a request that names the board makes it the run’s definition of done');
  assert.deepEqual(openStories(log, Date.now()), []);
  assert.equal(boardAt(log, log[0].at).stories.size, 1, 'the board as it stood after the first story');
  assert.equal(boardAt(log, Date.now()).sprint, 2);
});

test('a ceremony done by the scrum master alone, or skipped, isn’t held', () => {
  const held = (/** @type {ReturnType<typeof room>} */ r) => ceremonies(r.facts()).map((c) => c.name);
  // The scrum master sized every story itself, and assigned them: no estimation by the team, and no election.
  assert.deepEqual(held(sprintOne(room(), { sizers: ['alpha'], takers: ['alpha', 'alpha', 'alpha'] })), ['groomed', 'planned']);
  // Two of the three took a story.
  assert.deepEqual(held(sprintOne(room(), { takers: ['developer', 'critic'] })), ['groomed', 'estimated', 'planned']);
  // The whole backlog in one sprint is a plan, but not one by capacity.
  const all = sprintOne(room(), { taken: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'], takers: [] });
  assert.equal(TRIGGERS['sprint-planned'].run(all.facts()).length, 0);
  assert.deepEqual(held(all), ['groomed', 'estimated', 'planned']);
  // A second sprint that takes the action item and not the story sent back.
  const r = sprintOne();
  r.as('alpha', 'demo', '1');
  r.says('Demo: send the first story back.');
  r.as('alpha', 'return', 'S1', 'accents');
  r.as('alpha', 'action', 'smaller stories');
  r.as('alpha', 'plan', '2', 'the length', 'S4', 'A1');
  assert.equal(TRIGGERS['next-sprint-took-actions'].run(r.facts()).length, 0);
  // A story put back before the customer answered isn’t one they sent back.
  const early = sprintOne();
  early.as('alpha', 'demo', '1');
  early.as('alpha', 'return', 'S1', 'our own doubt');
  assert.deepEqual(held(early).slice(-1), ['demo']);
  // …and a story put back is the backlog’s again, not the sprint’s.
  assert.deepEqual(
    openStories(boardLog(early.facts()), Date.now()).map((s) => s.id),
    ['S2', 'S3'],
  );
  // A second sprint that takes the story sent back and no action item.
  const noAction = sprintOne();
  noAction.as('alpha', 'demo', '1');
  noAction.says('Demo: send the first story back.');
  noAction.as('alpha', 'return', 'S1', 'accents');
  noAction.as('alpha', 'plan', '2', 'accents', 'S1', 'S4');
  assert.equal(TRIGGERS['next-sprint-took-actions'].run(noAction.facts()).length, 0);
  // An action item noted mid-sprint, with none after the demo, isn’t a retrospective’s.
  const mid = sprintOne();
  mid.as('alpha', 'action', 'pair on the hard story');
  mid.as('alpha', 'demo', '1');
  assert.ok(!held(mid).includes('retro'), held(mid).join(', '));
});

test('grooming needs a backlog and a change to it, and estimates count before the sprint is planned', () => {
  const held = (/** @type {ReturnType<typeof room>} */ r) => ceremonies(r.facts()).map((c) => c.name);
  // Stories added and nothing done to them.
  const bare = room();
  for (const story of ['lowercase', 'no stray hyphens', 'untitled']) bare.as('alpha', 'add', story);
  assert.deepEqual(held(bare), []);
  bare.as('alpha', 'order', 'S2', 'S1', 'S3');
  assert.deepEqual(held(bare), ['groomed']);
  // Two stories aren’t a backlog to groom.
  const two = room();
  two.as('alpha', 'add', 'lowercase');
  two.as('alpha', 'add', 'untitled');
  two.as('alpha', 'order', 'S2', 'S1');
  assert.deepEqual(held(two), []);
  // Sizes given once the sprint is under way aren’t estimation for its plan.
  const late = sprintOne(room(), { sizers: [] });
  late.as('developer', 'estimate', 'S1', '2');
  late.as('critic', 'estimate', 'S1', '3');
  assert.deepEqual(held(late), ['groomed', 'planned', 'elected']);
});

test('a standup is a round of turns while a taken story isn’t done, and each quiet minute says what came before it', () => {
  // The real board’s lines, moved in time to sit inside the recorded sprint (the one edit to a record here): planning
  // and the three claims just before @alpha’s opening round at 07:38:30, and the rest after the room’s 11 quiet minutes.
  const r = toSprintTwo(sprintOne());
  const lines = boardLog({ workspace: r.dir });
  const claimed = lines.findLastIndex((x) => x.did === 'claim');
  const moved = lines.map((x, i) => ({ ...x, at: (i <= claimed ? 1795678709000 : 1795679600000) + i }));
  writeFileSync(join(r.dir, '.git', 'board-log.jsonl'), moved.map((x) => `${JSON.stringify(x)}\n`).join(''));
  const f = { events: recorded.events, workspaceKept: r.dir, threads: [] };
  const [standup, ...more] = ceremonies(f).filter((c) => c.name === 'standup');
  assert.equal(
    standup.evidence,
    '@alpha asked at 07:38:30 UTC, and @developer answered, @critic answered, @researcher answered, with 3 of the sprint’s stories not done.',
  );
  assert.deepEqual(TRIGGERS['standup-round-held'].run(f)[0], { at: standup.at, evidence: standup.evidence });
  // Later rounds of the same shape count too, as long as a taken story is open; none does once the stories are done.
  assert.ok(more.every((c) => c.at < 1795679600000));
  const [m] = afterCeremony(f, { asked: 1, queued: null, passed: null });
  assert.equal(m.title, 'What the sprint was doing each time the room went quiet');
  const [first] = m.evidence.split(' — ');
  assert.match(
    first,
    /^Quiet for 10 min 48 s from 07:40:39 UTC: waiting on a scheduled wake \(@researcher’s wake due at 07:51:27 UTC\); moved by @researcher’s scheduled wake\. It came after a standup\. Not done in the sprint: S1 \(@developer’s\), S2 \(@critic’s\), S3 \(@researcher’s\)\. @alpha’s last turn was woken by/,
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
  // A run with no board has no sprint to describe.
  assert.deepEqual(afterCeremony({ events: recorded.events, threads: [] }, { asked: 1, queued: null, passed: null }), []);
  assert.deepEqual(ceremonies({ events: recorded.events }), []);
  assert.deepEqual(boardLog({ workspace: join(r.dir, 'gone'), workspaceKept: r.dir }).length, lines.length, 'a recheck reads the kept workspace');
});
