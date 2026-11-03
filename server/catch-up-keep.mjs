// What a catch-up keeps of the items since an agent last took part, and the line that says what it left out (#484): the
// conversation's catch-up (server/catch-up.mjs) and a thread's (server/thread-summary.mjs, #507) keep them by the same
// rules. Moved from server/catch-up.mjs, so the two summaries share it without importing each other.

import { parseMentions } from '../shared/text.mjs';
import { CATCH_UP_CHARS } from './blocks.mjs';

export const CATCH_UP_ITEMS = 40;
/** How much a summary keeps of the messages that @-mention its agent, which come before the caps above (#484). Read
 * when called: blocks.mjs, which sets CATCH_UP_CHARS, imports this module's importers, so it isn't set at load. */
const mentionChars = () => 2 * CATCH_UP_CHARS;

/** Whether an item’s text @-mentions this handle. */
export const mentions = (item, handle) => typeof item?.text === 'string' && parseMentions(item.text, [handle]).includes(handle);

/**
 * The lines a summary keeps, in order: the messages that @-mention the agent first (#484), the newest within a cap of
 * their own, mentionChars(), past `maxItems` and CATCH_UP_CHARS; then the newest of the rest within those. A thread's
 * catch-up keeps them the same way, with its own item cap (#507, server/thread-summary.mjs).
 * @param {{ item: any, line: string }[]} entries @param {string} handle @param {number} [maxItems]
 */
export function keepFor(entries, handle, maxItems = CATCH_UP_ITEMS) {
  const kept = new Set();
  let size = 0;
  for (const e of entries.filter((x) => mentions(x.item, handle)).reverse()) {
    // The newest always goes, however long: its line is clipped already (describeItem).
    if (kept.size && size + e.line.length > mentionChars()) break;
    kept.add(e);
    size += e.line.length;
  }
  let count = kept.size;
  for (const e of [...entries].reverse()) {
    if (kept.has(e)) continue;
    if (count >= maxItems || size + e.line.length > CATCH_UP_CHARS) break;
    kept.add(e);
    size += e.line.length;
    count++;
  }
  return entries.filter((e) => kept.has(e));
}

/**
 * What a summary left out, by kind, and where read_conversation finds it: skip the newer items, in the thread it names
 * when the summary is a thread's (#507), so the hint doesn't send the agent into the main room.
 * @param {any[]} kept @param {any[]} left @param {any[]} items @param {string} handle @param {string|null} [thread]
 */
export function leftOut(kept, left, items, handle, thread = null) {
  const kinds = new Map();
  for (const { item } of left) {
    const plain = item?.kind === 'agent' ? 'agent' : item?.kind === 'user' ? 'user' : item?.kind === 'block' || item?.kind === 'app' ? 'block' : 'other';
    const kind = mentions(item, handle) ? 'mention' : plain;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const named = [...kinds].map(([kind, n]) => `${n} ${KINDS[kind][n === 1 ? 0 : 1]}`).join(', ');
  const newest = Math.max(-1, ...left.map((e) => (e.item ? items.indexOf(e.item) : -1)));
  // Counted as read_conversation counts, which lists a system line only if it’s a wake.
  const after = items.slice(newest + 1).filter((i) => i.kind !== 'system' || i.variant === 'wake').length;
  const call = thread
    ? `read_conversation { thread: "${thread}"${newest < 0 ? '' : `, skip: ${after}`} }`
    : `read_conversation${newest < 0 ? '' : ` with skip: ${after}`}`;
  const read = `${call} has them`;
  // A mention kept ahead of newer items left out means what’s kept isn’t the last N, so the line doesn't say it is.
  const gap = kept.some((e) => e.item && items.indexOf(e.item) < newest);
  const which = gap ? `${kept.length} kept, mentions of you first; ${left.length}` : `the last ${kept.length}; ${left.length} earlier`;
  return `(${which} ${left.length === 1 ? 'item is' : 'items are'} left out: ${named}, and ${read})`;
}

const KINDS = {
  mention: ['mention of you', 'mentions of you'],
  agent: ['message from another agent', 'messages from other agents'],
  user: ['message from the person', 'messages from the person'],
  block: ['block or app', 'blocks and apps'],
  other: ['other update', 'other updates'],
};
