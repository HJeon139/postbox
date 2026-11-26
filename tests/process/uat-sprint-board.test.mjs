// The idleroom scenarios’ sprint board (tests/uat/e2e/fixtures/sprint/board.mjs, #1746) as a tool: what it refuses,
// one change at a time, a lock left behind, and where BOARD.md goes. The real tool in a throwaway repository
// (tests/process/sprint-room.mjs). It runs git and node, so it’s under tests/process/ (npm run test:process).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';
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

test('a lock a killed command left behind is taken over, a fresh one is waited for, and BOARD.md is the repository’s', () => {
  const r = room();
  r.as('alpha', 'add', 'lowercase');
  const lock = join(r.dir, '.git', 'board.lock');
  mkdirSync(lock);
  assert.match(r.as('alpha', 'add', 'digits').said, /^Not done: The board is busy/);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.deepEqual(r.as('alpha', 'add', 'untitled'), { said: 'S2: untitled', code: 0 });
  // Wherever in the repository the command runs, there is one BOARD.md, at its top.
  mkdirSync(join(r.dir, 'src'));
  spawnSync(process.execPath, ['../board.mjs', 'add', 'digits'], { cwd: join(r.dir, 'src'), timeout: 30_000 });
  assert.equal(existsSync(join(r.dir, 'src', 'BOARD.md')), false);
  assert.match(readFileSync(join(r.dir, 'BOARD.md'), 'utf8'), /\| S3 \| digits \|/);
});
