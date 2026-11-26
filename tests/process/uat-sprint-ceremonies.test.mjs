// What the UAT reads of the sprint board (tools/uat/board-log.mjs, sprint-ceremonies.mjs, sprint-triggers.mjs, #1746):
// each ceremony, who did it, and what “work is waiting” means. The real board in a throwaway repository, driven through two sprints as a team would drive it
// (tests/process/sprint-room.mjs says what the test writes itself). It runs git and node, so it’s under tests/process/.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardAt, boardLog, openStories, sprintWork, workOf } from '../../tools/uat/board-log.mjs';
import { ceremonies } from '../../tools/uat/sprint-ceremonies.mjs';
import { TRIGGERS } from '../../tools/uat/triggers.mjs';
import { room, sprintOne, toSprintTwo } from './sprint-room.mjs';

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
  const answer = r.events.filter((/** @type {any} */ e) => e.type === 'item.add')[1].data.item;
  assert.equal(customer.to, answer.at, 'the answer closed the wait, before the team’s next change to the board');
  assert.ok(customer.to > customer.from);
  assert.equal(customer.what, 'the customer’s answer to sprint 1’s demo');
  // A new plan starts its stories afresh: the story sent back is nobody’s yet, though @developer had it in sprint 1.
  assert.deepEqual(
    openStories(boardLog(f()), Date.now()).map((x) => [x.id, x.owner]),
    [
      ['S1', null],
      ['S4', null],
    ],
  );
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
  r.as('developer', 'done', 'S1');
  r.as('alpha', 'demo', '1');
  r.says('Demo: send the first story back.');
  r.as('alpha', 'return', 'S1', 'accents');
  r.as('alpha', 'action', 'smaller stories');
  r.as('alpha', 'plan', '2', 'the length', 'S4', 'A1');
  assert.equal(TRIGGERS['next-sprint-took-actions'].run(r.facts()).length, 0);
  // What’s open is the newest sprint’s: S2 and S3, left undone in sprint 1, aren’t this sprint’s work.
  assert.deepEqual(
    openStories(boardLog(r.facts()), Date.now()).map((x) => x.id),
    ['S4'],
  );
  // A story put back before the customer answered isn’t one they sent back.
  const early = sprintOne();
  early.as('developer', 'done', 'S1');
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
  noAction.as('developer', 'done', 'S1');
  noAction.as('alpha', 'demo', '1');
  noAction.says('Demo: send the first story back.');
  noAction.as('alpha', 'return', 'S1', 'accents');
  noAction.as('alpha', 'plan', '2', 'accents', 'S1', 'S4');
  assert.equal(TRIGGERS['next-sprint-took-actions'].run(noAction.facts()).length, 0);
  // An action item noted mid-sprint, with none after the demo, isn’t a retrospective’s.
  const mid = sprintOne();
  mid.as('alpha', 'action', 'pair on the hard story');
  mid.as('developer', 'done', 'S1');
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

test('a demo is the sprint shown with a story done, and the room waits on the customer only until they answer or the team moves on', () => {
  const r = sprintOne();
  // A look at where the sprint stands, with nothing done, is no demo, and nobody waits on the customer for it.
  assert.equal(r.as('alpha', 'demo', '1').said, 'S1 lowercase: in progress\nS2 no stray hyphens: in progress\nS3 untitled: in progress');
  assert.deepEqual(sprintWork(r.facts()).customer, []);
  assert.equal(TRIGGERS['demo-shown'].run(r.facts()).length, 0);
  r.as('developer', 'done', 'S1');
  r.as('alpha', 'demo', '1');
  assert.equal(TRIGGERS['demo-shown'].run(r.facts()).length, 1);
  assert.equal(sprintWork(r.facts()).customer?.[0].to, Number.POSITIVE_INFINITY);
  // The team goes on without an answer: the wait ended at its next change to the board.
  r.as('critic', 'done', 'S2');
  assert.equal(sprintWork(r.facts()).customer?.[0].to, boardLog(r.facts()).at(-1).at);
});

test('three of the team taking their stories in the same moment are each credited with their own', () => {
  const r = sprintOne(room(), { takers: [] });
  const team = [
    ['developer', 'S1'],
    ['critic', 'S2'],
    ['researcher', 'S3'],
  ];
  // As three turns do it: every command has started before any has written its line.
  for (const [who, id] of team) r.starts(who, 'claim', id, who);
  // Another agent’s look at the board in the same window takes nobody’s line.
  r.starts('alpha', 'show');
  for (const [who, id] of [team[1], team[0], team[2]]) r.runs('claim', id, who);
  const [elected] = TRIGGERS['tasks-elected'].run(r.facts());
  assert.equal(elected.evidence, '@critic, @developer, @researcher each took a story of sprint 1 themselves.');
});

test('a story the customer sent back counts when a later sprint simply takes it again', () => {
  const r = sprintOne();
  r.as('developer', 'done', 'S1');
  r.as('alpha', 'demo', '1');
  r.says('Demo: accepted, except the first story. Take it back into the next sprint.');
  r.as('alpha', 'action', 'agree the acceptance first');
  r.as('alpha', 'plan', '2', 'accents', 'S1', 'S4', 'A1');
  assert.match(TRIGGERS['story-sent-back'].run(r.facts())[0].evidence, /^S1 was taken again into sprint 2 after the customer’s answer\.$/);
  assert.equal(TRIGGERS['next-sprint-took-actions'].run(r.facts()).length, 1);
  // Taken again, it is open again and nobody’s, though it was done and @developer’s in sprint 1.
  assert.deepEqual(
    openStories(boardLog(r.facts()), Date.now()).map((x) => [x.id, x.owner]),
    [
      ['S1', null],
      ['S4', null],
    ],
  );
  // A story planned again with no demo answered between isn’t one the customer sent back.
  const again = sprintOne();
  again.as('alpha', 'plan', '2', 'the same again', 'S1', 'S4');
  assert.equal(TRIGGERS['story-sent-back'].run(again.facts()).length, 0);
});
