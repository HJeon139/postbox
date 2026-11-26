// The sprint board’s own record, for the idleroom scenarios (#1746): tests/uat/e2e/fixtures/sprint/board.mjs keeps a
// line for every change the team makes to the board (a story added, an estimate, a sprint’s plan, a story taken,
// reviewed, done or sent back, an action item), in the workspace’s .git folder, which the run keeps with the workspace. Read from
// there, so it’s the same on every backend. Who made a change isn’t in the record, since the tool can’t know: the
// work ledger in the event history says which agent ran the command (whoRan).
//
// From it comes what “work is waiting” means in a sprint room: from the person’s request that names the board until
// the second sprint’s stories are all done, and, between the demo and the customer’s answer, the room waits on the
// person, not on its work (tools/uat/quiet-stretches.mjs).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nightlyWork } from './nightly-log.mjs';

/** The person’s request names the board the team keeps. */
export const BOARD = /\bboard\.mjs\b/;

/** The board’s record in a run’s workspace, oldest first; none when the run had no board. @param {{ workspace?: string|null, workspaceKept?: string|null }} f */
export function boardLog(f) {
  const root = f.workspaceKept ?? f.workspace;
  const path = root ? join(root, '.git', 'board-log.jsonl') : null;
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * The board as it stood at a moment: each story’s sprint, owner and whether it’s done, and the newest sprint.
 * @param {any[]} log  @param {number} at
 * @returns {{ sprint: number|null, stories: Map<string, { id: string, sprint: number|null, owner: string|null, done: boolean }> }}
 */
export function boardAt(log, at) {
  /** @type {Map<string, { id: string, sprint: number|null, owner: string|null, done: boolean }>} */
  const stories = new Map();
  let sprint = null;
  const fresh = (/** @type {string} */ id) => stories.set(id, { id, sprint: null, owner: null, done: false });
  for (const x of log) {
    if (x.at > at) break;
    if (x.did === 'add') fresh(x.story);
    else if (x.did === 'split') {
      stories.delete(x.story);
      for (const id of x.into) fresh(id);
    } else if (x.did === 'plan') {
      sprint = x.sprint;
      for (const id of x.items) if (stories.has(id)) stories.set(id, { id, sprint, owner: null, done: false });
    } else if (x.did === 'claim') Object.assign(stories.get(x.story) ?? {}, { owner: x.who });
    else if (x.did === 'done') Object.assign(stories.get(x.story) ?? {}, { done: true });
    else if (x.did === 'return') fresh(x.story);
  }
  return { sprint, stories };
}

/** The newest sprint’s stories that aren’t done at a moment, with whose each is. @param {any[]} log @param {number} at */
export function openStories(log, at) {
  const { sprint, stories } = boardAt(log, at);
  return [...stories.values()].filter((s) => sprint !== null && s.sprint === sprint && !s.done);
}

/** When the second sprint’s stories were first all done, or null. @param {any[]} log */
function finishedAt(log) {
  for (const x of log) {
    const { sprint } = boardAt(log, x.at);
    if (x.did === 'done' && sprint !== null && sprint >= 2 && !openStories(log, x.at).length) return x.at;
  }
  return null;
}

/**
 * What the board’s own rules were holding a story for at a moment, in words, or '': a story nobody could take because
 * a story it waits on wasn’t done, or one reviewed and never marked done. A room that stopped there stopped at the
 * board, which isn’t the stall after a standup (#1784).
 * @param {any[]} log  @param {string} id  @param {number} at
 */
export function heldBy(log, id, at) {
  const { stories } = boardAt(log, at);
  const mine = log.filter((x) => x.at <= at && x.story === id);
  if (!stories.get(id)?.owner) {
    const waits = (mine.findLast((x) => x.did === 'needs')?.needs ?? []).filter((/** @type {string} */ n) => !stories.get(n)?.done);
    return waits.length ? `the board won’t let it be taken until ${waits.join(', ')} ${waits.length === 1 ? 'is' : 'are'} done` : '';
  }
  const taken = mine.findLast((x) => x.did === 'claim')?.at ?? 0;
  const review = mine.findLast((x) => x.did === 'review' && x.at > taken);
  return review ? `reviewed by @${review.who} and not marked done` : '';
}

/** The person’s messages, oldest first. @param {{ events?: any[] }} f */
export const personSaid = (f) => (f.events ?? []).filter((e) => e?.type === 'item.add' && e.data?.item?.kind === 'user').map((e) => e.data.item);

/**
 * Each demo the team gave: a `demo` line when a story of that sprint was done, since a demo shows working software and
 * the same command also just prints where a sprint stands. With the person’s answer, their next message, and how long
 * the room waited on them for it: until that message, or the team’s next change to the board if that came first.
 * @param {{ events?: any[] }} f  @param {any[]} log
 * @returns {{ at: number, sprint: number, answer: any|null, until: number }[]}
 */
export function demos(f, log) {
  const said = personSaid(f);
  return log
    .filter((x) => x.did === 'demo' && [...boardAt(log, x.at).stories.values()].some((s) => s.sprint === x.sprint && s.done))
    .map((x) => {
      const answer = said.find((m) => m.at > x.at) ?? null;
      const changed = log.find((y) => y.at > x.at)?.at ?? Number.POSITIVE_INFINITY;
      return { at: x.at, sprint: x.sprint, answer, until: Math.min(answer?.at ?? Number.POSITIVE_INFINITY, changed) };
    });
}

/**
 * What “work is waiting” means for a sprint room: asked when the person’s request named the board, passed when the
 * second sprint’s stories were all done, and waiting on the person from each demo until their answer.
 * @param {{ workspace?: string|null, workspaceKept?: string|null, events?: any[] }} f  @returns {import('./quiet-stretches.mjs').Work}
 */
export function sprintWork(f) {
  const log = boardLog(f);
  const passed = finishedAt(log);
  const customer = demos(f, log).map((d) => ({ from: d.at, to: d.until, what: `the customer’s answer to sprint ${d.sprint}’s demo` }));
  const asked = personSaid(f).find((m) => BOARD.test(m.text ?? ''))?.at ?? null;
  return { asked, queued: null, passed: passed === null ? null : { at: passed }, customer };
}

/** The run’s definition of done: the sprint board’s when the person’s request named the board, else the nightly check’s. @param {any} f */
export function workOf(f) {
  const sprint = sprintWork(f);
  return sprint.asked === null ? nightlyWork(f) : sprint;
}

/**
 * Which agent ran the board command that made a record’s line, from the work ledger in the event history: of the
 * shell commands naming the board that started in the two minutes before it, the newest whose text says what the
 * line did (`claim S2`), since agents taking their stories start their commands in the same second; else the newest.
 * Two agents may run the same words at once, as when each estimates every story: a command makes one such line, so
 * `used` holds the commands already credited with one and the next line goes to another. Null when the run recorded
 * none.
 * @param {{ events?: any[] }} f  @param {number} at  @param {RegExp} [script]  @param {RegExp|null} [did]  @param {Set<any>} [used]
 * @returns {string|null}
 */
export function whoRan(f, at, script = BOARD, did = null, used = new Set()) {
  const ran = (f.events ?? [])
    .filter((e) => e?.type === 'work.add' && e.data?.entry?.kind === 'command' && script.test(e.data.entry.command ?? ''))
    .map((e) => e.data.entry)
    .filter((c) => c.startedAt <= at && at - c.startedAt < 120_000);
  const same = did ? ran.filter((c) => did.test(c.command)) : [];
  const by = same.findLast((c) => !used.has(c)) ?? same.at(-1) ?? ran.at(-1);
  if (by) used.add(by);
  return by?.handle ?? null;
}
