// Whether a line of a message is a copy of an item’s line, as Postbox gave it to an agent, for parseMentions
// (shared/text.mjs): a copy names its agent without waking it (designs/rooms-at-scale.md, “Which mention wakes”).

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
 * For one conversation, as one of its agents reads it: (itemId, said) is true when the conversation or one of its
 * topic or side threads holds that item, and `said` is its line’s words. A line with an id that isn’t an item’s, or
 * with words of the message’s own after it, is not a copy, so its mention wakes.
 * @param {any} rt @param {any} se  the agent whose message it is
 * @returns {(itemId: string, said: string) => boolean}
 */
export function copiedLine(rt, se) {
  // Worked out once for a message, and only if it has a line to check: finding a conversation’s threads walks every
  // thread in the store.
  /** @type {string[] | null} */
  let threads = null;
  return (itemId, said) => {
    const here = (threads ??= rt.threads.conversationThreads(se.threadId));
    const item = here.map((/** @type {string} */ th) => rt.store.item(th, itemId)).find(Boolean);
    const line = item ? plain(rt.memory.readLine(item, se, Number.POSITIVE_INFINITY) ?? '') : '';
    const parts = pieces(said);
    // A mention with nothing of the item after it, “[it_x] @beta”, is the message’s own.
    const words = parts
      .join(' ')
      .replace(/^@[A-Za-z0-9_-]+:?/, '')
      .trim();
    return Boolean(line) && Boolean(words) && parts.every((p) => line.includes(p));
  };
}
