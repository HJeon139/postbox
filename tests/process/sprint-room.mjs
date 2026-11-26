// What the sprint board’s process tests share (tests/process/uat-sprint-*.test.mjs): a throwaway repository with the
// real board tool in it (tests/uat/e2e/fixtures/sprint/board.mjs), driven as a team would drive it, and the events its
// commands leave. No run has used the board yet, so who ran each command comes from ledger lines written here in the
// shape the recorded runs have (tests/fixtures/uat/idleroom-2026-11-26.json), one for each command started.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../uat/e2e/fixtures/sprint', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'pb-test-board-'));
after(() => rmSync(home, { recursive: true, force: true }));

/** A sprint room’s workspace and the events its commands leave: `as` runs the board as an agent, `says` is the person. */
export function room() {
  const dir = mkdtempSync(join(home, 'workspace-'));
  spawnSync('git', ['init', '-q'], { cwd: dir, timeout: 30_000 });
  cpSync(FIXTURE, dir, { recursive: true });
  /** @type {any[]} */
  const events = [];
  /** The ledger’s line for a command an agent starts. */
  const starts = (/** @type {string} */ handle, /** @type {string[]} */ ...args) =>
    events.push({ type: 'work.add', data: { entry: { kind: 'command', handle, startedAt: Date.now(), command: `node board.mjs ${args.join(' ')}` } } });
  const runs = (/** @type {string[]} */ ...args) => {
    const r = spawnSync(process.execPath, ['board.mjs', ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    return { said: r.stdout.trim(), code: r.status };
  };
  const as = (/** @type {string} */ handle, /** @type {string[]} */ ...args) => {
    starts(handle, ...args);
    return runs(...args);
  };
  const says = (/** @type {string} */ text) =>
    events.push({ type: 'item.add', data: { threadId: 't', item: { id: `it_${events.length}`, at: Date.now(), kind: 'user', text } } });
  /** A story finished as the board asks: another of the team reviews it, then its owner marks it done. */
  const finish = (/** @type {string} */ who, /** @type {string} */ id) => {
    const reviewer = who === 'critic' ? 'researcher' : 'critic';
    as(reviewer, 'review', id, reviewer);
    return as(who, 'done', id);
  };
  return { dir, events, as, starts, runs, says, finish, facts: () => ({ events, workspace: dir }) };
}

/** Sprint 1 up to its demo: six stories groomed, sized by two of the team, three taken, each by its own agent, all done. */
export function sprintOne(r = room(), { sizers = ['developer', 'critic'], takers = ['developer', 'critic', 'researcher'], taken = ['S1', 'S2', 'S3'] } = {}) {
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
export function toSprintTwo(/** @type {ReturnType<typeof room>} */ r) {
  for (const [who, id] of [
    ['developer', 'S1'],
    ['critic', 'S2'],
    ['researcher', 'S3'],
  ])
    r.finish(who, id);
  r.as('alpha', 'demo', '1');
  r.says('Demo: I accept the sprint, except the story about lowercase words: it must also drop accents.');
  r.as('alpha', 'return', 'S1', 'must drop accents');
  r.as('alpha', 'action', 'agree the acceptance with the customer before building');
  r.as('alpha', 'plan', '2', 'accents, and the length', 'S1', 'S4', 'A1');
  return r;
}
