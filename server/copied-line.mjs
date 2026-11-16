// Whether a line of a message is a copy of an item’s line, as Postbox gave it to an agent, for parseMentions
// (shared/text.mjs): a copy names its agent without waking it (designs/rooms-at-scale.md, “Which mention wakes”).

import { withoutCode } from '../shared/text.mjs';

/** Text as one run of single spaces, with an agent’s own “You (@x)” as others read it. */
const plain = (/** @type {string} */ s) =>
  String(s ?? '')
    .replace(/You \((@[A-Za-z0-9_-]+)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Who an entry is from, as a turn gives it (entryLine in server/turn-input.mjs): the sender, what the entry is, its
 * time, and whether it was sent again, as in “@critic, a review of your block, 14:02 UTC: ”. Read as “@critic: ”, which
 * is how the item’s own line starts, so a copied entry is a copy by the same rule as any other line.
 */
const ENTRY_FROM = /^(@[A-Za-z0-9_-]+), [^:]*?\d\d:\d\d UTC[^:]*: /;

/** What a cut line ends with: how much of it was kept, and the call that reads the rest. */
const CUT_NOTE = /^\([\d,]+ (?:of [\d,]+ )?characters\b/;

/**
 * The pieces of a line that must be the item’s words: the line split where it was cut (“…”), without the note a cut
 * leaves. A search hit has a cut at each end, and a long line one at its end.
 */
const pieces = (/** @type {string} */ said) =>
  plain(said)
    .replace(ENTRY_FROM, '$1: ')
    .split('…')
    .map((p) => p.trim())
    .filter((p) => p && !CUT_NOTE.test(p));

/**
 * An item’s line as a message’s lines are compared with it: without its code, as parseMentions reads a message
 * without its code, and line by line, each with the place it ends in the whole. `stands` is how many of its lines a
 * copy has reached.
 * @typedef {{ flat: string, lines: string[], ends: number[], stands: number }} Copied
 */

/** @param {string} line  the item’s line, as readLine gives it @returns {Copied} */
function copiedOf(line) {
  const lines = withoutCode(line).split('\n').map(plain).filter(Boolean);
  let end = -1;
  const ends = lines.map((l) => (end += l.length + 1));
  return { flat: lines.join(' '), lines, ends, stands: 0 };
}

/**
 * Whether a line that starts with the item’s id is its words: every piece of it is in the item’s line, in order, and
 * there is more to it than who wrote it. The copy then stands after the last line of the item it reached.
 * @param {Copied} item @param {string} said
 */
function starts(item, said) {
  const parts = pieces(said);
  // A mention with nothing of the item after it, “[it_x] @beta”, is the message’s own.
  const words = parts
    .join(' ')
    .replace(/^@[A-Za-z0-9_-]+:?/, '')
    .trim();
  let at = 0;
  for (const p of parts) {
    const found = item.flat.indexOf(p, at);
    if (found < 0) return false;
    at = found + p.length;
  }
  if (!words) return false;
  item.stands = item.ends.filter((end) => end <= at).length;
  return true;
}

/**
 * Whether a line after a copy goes on with it: it is one of the item’s lines, whole, at or after where the copy
 * stands, or the start of one when the line was cut. Part of a line isn’t: “@gamma can you look” after a copy is a
 * hand-off though the item says “@gamma can you look at step two?”, and a lost hand-off is worse than an extra wake.
 * @param {Copied} item @param {string} said
 */
function goesOn(item, said) {
  const whole = plain(said);
  const [first, ...rest] = pieces(said);
  const cut = whole.includes('…') && rest.length === 0;
  const is = (/** @type {string} */ line) => (cut ? Boolean(first) && line.startsWith(first) : line === whole);
  const found = item.lines.findIndex((line, i) => i >= item.stands && is(line));
  if (found < 0) return false;
  item.stands = found + 1;
  return true;
}

/**
 * For one message, in one conversation, as one of its agents reads it: (itemId, said) is true when the conversation
 * or one of its topic or side threads holds that item, and `said` is its line’s words. A line with an id that isn’t an
 * item’s, or with words of the message’s own after it, is not a copy, so its mention wakes. `more` says the line
 * comes after a copy of that item, and asks whether it goes on with it.
 * @param {any} rt @param {any} se  the agent whose message it is
 * @returns {(itemId: string, said: string, more?: boolean) => boolean}
 */
export function copiedLine(rt, se) {
  // Worked out once for a message, and only if it has a line to check: finding a conversation’s threads walks every
  // thread in the store, and an item’s line is read and split once however many lines of it the message copies.
  /** @type {string[] | null} */
  let threads = null;
  /** @type {Map<string, Copied | null>} */
  const items = new Map();
  const itemOf = (/** @type {string} */ itemId) => {
    if (items.has(itemId)) return items.get(itemId) ?? null;
    const here = (threads ??= rt.threads.conversationThreads(se.threadId));
    const item = here.map((/** @type {string} */ th) => rt.store.item(th, itemId)).find(Boolean);
    const line = item ? rt.memory.readLine(item, se, Number.POSITIVE_INFINITY) : null;
    const copied = line ? copiedOf(line) : null;
    items.set(itemId, copied);
    return copied;
  };
  return (itemId, said, more = false) => {
    const item = itemOf(itemId);
    if (!item?.flat) return false;
    return more ? goesOn(item, said) : starts(item, said);
  };
}
