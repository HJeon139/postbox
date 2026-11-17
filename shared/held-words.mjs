// What a turn that died held, in words (designs/rooms-at-scale.md, “Live state”): the line a
// failed reply with no words of its own shows before its error, from the record the turn’s end keeps on it
// (server/turn-held.mjs).

/**
 * @typedef {{ took: { from?: string, itemId?: string }[], steps: number, last: string | null, jobs: string[] }} Held
 */

/** A list as a sentence says it: “a”, “a and b”, “a, b and c”. @param {string[]} xs */
const listed = (xs) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Whom an entry came from, as the room names them: the person, an agent, or Postbox. @param {string | undefined} from */
function named(from) {
  if (from === 'you') return 'you';
  return from ? `@${from}` : 'Postbox';
}

/**
 * The line: whom it was answering, how far it got, and the background jobs it left running; empty with no record.
 * @param {Held | null | undefined} held
 */
export function heldWords(held) {
  if (!held) return '';
  const parts = [opening(held)];
  if (held.took.length && held.steps) parts.push(gotTo(held));
  if (held.jobs.length) parts.push(`${held.jobs.length} ${held.jobs.length === 1 ? 'job' : 'jobs'} still running: ${listed(held.jobs)}`);
  return parts.join(' · ');
}

/** How far it got: its step count and its last step. @param {Held} held */
const gotTo = (held) => `got to step ${held.steps}${held.last ? `, ${held.last}` : ''}`;

/** The line’s start: whom it was answering, or with no one, how far it got. @param {Held} held */
function opening(held) {
  const who = listed([...new Set(held.took.map((e) => named(e.from)))]);
  if (!who) return held.steps ? `It ${gotTo(held)}` : 'It ended before its first step';
  return held.steps ? `It was answering ${who}` : `It was answering ${who}, before its first step`;
}
