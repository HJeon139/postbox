// What a turn that died held, in words (designs/rooms-at-scale.md, “Live state”): the line its reply shows before its
// error or its stop, from the record kept on it (server/turn-held.mjs).

/**
 * @typedef {{ took: { from?: string }[], steps: number, last: string | null, running: string[], stopped: string[] }} Held
 */

/** A list as a sentence says it: “a”, “a and b”, “a, b and c”. @param {string[]} xs */
const listed = (xs) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Whom an entry came from, as the room names them: the person, an agent, or Postbox. @param {string | undefined} from */
function named(from) {
  if (from === 'you') return 'you';
  return from ? `@${from}` : 'Postbox';
}

/** How far it got: its step count and its last step. @param {Held} held */
const gotTo = (held) => `got to step ${held.steps}${held.last ? `, ${held.last}` : ''}`;

/** The line’s start: whom it was answering, or with no one, how far it got. @param {Held} held */
function opening(held) {
  const who = listed([...new Set(held.took.map((e) => named(e.from)))]);
  if (!who) return held.steps ? `It ${gotTo(held)}` : 'It ended before its first step';
  return held.steps ? `It was answering ${who}` : `It was answering ${who}, before its first step`;
}

/** “1 job still running: x”, or nothing. @param {string[]} labels @param {string} how */
function jobs(labels, how) {
  if (!labels.length) return null;
  return `${labels.length} ${labels.length === 1 ? 'job' : 'jobs'} ${how}: ${listed(labels)}`;
}

/**
 * The line, as a sentence: whom it was answering, how far it got, and its background jobs as its end left them;
 * empty with no record. A last step that ends a sentence of its own gets no second stop.
 * @param {Held | null | undefined} held
 */
export function heldWords(held) {
  if (!held) return '';
  const parts = [opening(held)];
  if (held.took.length && held.steps) parts.push(gotTo(held));
  for (const part of [jobs(held.running ?? [], 'still running'), jobs(held.stopped ?? [], 'stopped with it')]) if (part) parts.push(part);
  const line = parts.join(' · ');
  return /[.?!…]$/.test(line) ? line : `${line}.`;
}
