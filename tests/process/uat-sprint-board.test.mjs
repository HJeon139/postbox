// The idleroom scenarios’ sprint board (tests/uat/e2e/fixtures/sprint/board.mjs, #1746) as a tool: what it refuses,
// one change at a time, a lock left behind, and where BOARD.md goes. The real tool in a throwaway repository
// (tests/process/sprint-room.mjs). It runs git and node, so it’s under tests/process/ (npm run test:process).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardLog } from '../../tools/uat/board-log.mjs';
import { room } from './sprint-room.mjs';

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
  assert.match(readFileSync(join(r.dir, 'BOARD.md'), 'utf8'), /\| S1 \| lowercase \| {2}\| {2}\| {2}\| {2}\| backlog \|/);
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

test('a lock a killed command left behind is taken over, a fresh one is waited for, and BOARD.md is the repository’s', () => {
  const r = room();
  r.as('alpha', 'add', 'lowercase');
  const lock = join(r.dir, '.git', 'board.lock');
  mkdirSync(lock);
  assert.match(r.as('alpha', 'add', 'digits').said, /^Not done: The board is busy/);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.deepEqual(r.as('alpha', 'add', 'untitled'), { said: 'S2: untitled', code: 0 });
  // A folder the board can’t write to isn’t “busy”: the command says what stopped it, at once.
  chmodSync(join(r.dir, '.git'), 0o555);
  const refused = r.as('alpha', 'add', 'a command');
  chmodSync(join(r.dir, '.git'), 0o755);
  assert.match(refused.said, /^Not done: EACCES: permission denied, mkdir/);
  assert.equal(refused.code, 1);
  // Wherever in the repository the command runs, there is one BOARD.md, at its top.
  mkdirSync(join(r.dir, 'src'));
  spawnSync(process.execPath, ['../board.mjs', 'add', 'digits'], { cwd: join(r.dir, 'src'), timeout: 30_000 });
  assert.equal(existsSync(join(r.dir, 'src', 'BOARD.md')), false);
  assert.match(readFileSync(join(r.dir, 'BOARD.md'), 'utf8'), /\| S3 \| digits \|/);
});

test('a story waits on the stories it needs, and is done only once another of the team has reviewed it', () => {
  const r = room();
  for (const story of ['words', 'slug', 'title case']) r.as('alpha', 'add', story);
  assert.equal(r.as('alpha', 'needs', 'S2', 'S1').said, 'S2 waits on S1');
  r.as('alpha', 'plan', '1', 'words and what builds on them', 'S1', 'S2', 'S3');
  // The story that builds on another can’t be taken until that one is done.
  assert.deepEqual(r.as('critic', 'claim', 'S2', 'critic'), { said: 'Not done: S2 waits on S1, which isn’t done.', code: 1 });
  r.as('developer', 'claim', 'S1', 'developer');
  // Its owner can’t call it done alone, nor review it themselves.
  assert.equal(
    r.as('developer', 'done', 'S1').said,
    'Not done: S1 hasn’t been reviewed. Another of the team reviews it first, with “node board.mjs review S1 <who>”.',
  );
  assert.equal(r.as('developer', 'review', 'S1', 'developer').said, 'Not done: S1 is developer’s own. Another of the team reviews it.');
  assert.match(r.as('critic', 'review', 'S3', 'critic').said, /^Not done: review takes a story someone has taken/);
  assert.equal(r.as('critic', 'review', 'S1', 'critic').said, 'S1 is reviewed by critic');
  const board = readFileSync(join(r.dir, 'BOARD.md'), 'utf8');
  assert.ok(board.includes('| S1 | words |  |  | 1 | developer | reviewed by critic |\n| S2 | slug |  | S1 | 1 |  | to do |'), board);
  assert.equal(r.as('developer', 'done', 'S1').said, 'S1 is done');
  assert.equal(r.as('critic', 'claim', 'S2', 'critic').said, 'S2 is critic’s');
  assert.deepEqual(
    boardLog({ workspace: r.dir }).map((x) => x.did),
    ['add', 'add', 'add', 'needs', 'plan', 'claim', 'review', 'done', 'claim'],
  );
  // A story planned again starts afresh: its review was for the sprint before.
  r.as('alpha', 'plan', '2', 'again', 'S1');
  r.as('developer', 'claim', 'S1', 'developer');
  assert.match(r.as('developer', 'done', 'S1').said, /^Not done: S1 hasn’t been reviewed/);
});
