// How big a sprint’s stories were, as a run’s records show it (#1784): for each time a story was taken, how long it
// was open, how many turns its owner took on it, and who reviewed it. The first sprint run’s stories were each done
// within 30 seconds of being taken, in the turn that took them, so no standup could land on open work and the room
// was never quiet with a story open: whether a sprint is long enough to show #1746’s stall is read from this.
// From the board’s own record (tools/uat/board-log.mjs) and the turns in the event history (tools/uat/standup.mjs).

import { turnsIn } from './standup.mjs';

const handleOf = (/** @type {unknown} */ who) => String(who ?? '').replace(/^@/, '');

/**
 * Each time a story was taken: by whom, when, when it was done and who reviewed it, and the owner’s turns on it, the
 * one that took it and each it started while the story was open.
 * @param {{ events?: any[] }} f  @param {any[]} log  the board’s record  @param {number} [until]  count turns up to here
 * @returns {{ story: string, owner: string, at: number, doneAt: number|null, reviewedBy: string|null, turns: number }[]}
 */
export function storySizes(f, log, until = Number.POSITIVE_INFINITY) {
  const turns = turnsIn(f);
  return log
    .filter((x) => x.did === 'claim' && x.at <= until)
    .map((taken) => {
      const owner = handleOf(taken.who);
      const next = (/** @type {string} */ did) => log.find((x) => x.did === did && x.story === taken.story && x.at > taken.at && x.at <= until);
      const doneAt = next('done')?.at ?? null;
      const end = Math.min(doneAt ?? Number.POSITIVE_INFINITY, until);
      const during = turns.filter((t) => t.handle === owner && t.startedAt > taken.at && t.startedAt <= end).length;
      return { story: taken.story, owner, at: taken.at, doneAt, reviewedBy: next('review') ? handleOf(next('review').who) : null, turns: 1 + during };
    });
}

/** The stories someone had taken that weren’t done at a moment, with how long each had been open and its owner’s turns so far. @param {{ events?: any[] }} f @param {any[]} log @param {number} at */
export function openAt(f, log, at) {
  return storySizes(f, log, at)
    .filter((s) => s.doneAt === null)
    .map((s) => ({ ...s, ms: at - s.at }));
}
