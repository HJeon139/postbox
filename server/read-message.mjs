// Reading one conversation item, with the same scope and pagination as the conversation history.
import { READING } from '../shared/limits.mjs';
import { clipText } from './helpers.mjs';

const count = (n) => n.toLocaleString('en-US');

/**
 * read_message: one item in full, by its id (the history and read_conversation give it where they cut one) or by
 * a block’s id, from any thread of this conversation: read_conversation { thread } reads its side and topic threads,
 * a fork’s among them (#110), so the ids it gives must work here too. Its own thread and the conversation it
 * branched from come first. Long text comes in parts (#109).
 * @param {any} rt @param {any} se @param {{ id?: string, from?: number }} [args]
 */
export function readMessage(rt, se, { id, from = 0 } = {}) {
  const key = String(id ?? '').trim();
  if (!key) return { ok: false, message: 'Name the item: read_message { id }, with an id from your history or read_conversation.' };
  const threads = rt.conversationThreads(se.threadId);
  let it = threads.map((th) => rt.store.item(th, key)).find(Boolean);
  if (!it) {
    const blocks = threads.flatMap((th) => rt.store.items(th).filter((i) => i.kind === 'block' && i.valid && i.block?.id === key));
    if (blocks.length > 1)
      return {
        ok: false,
        message: `More than one block is called “${key}”: ${blocks.map((b) => `@${b.handle}’s is ${b.id}`).join(', ')}. Read one by that id.`,
      };
    it = blocks[0];
  }
  if (!it)
    return {
      ok: false,
      message: `There’s no item “${clipText(key, 80)}” in this conversation. Your history and read_conversation give the id of each item they cut.`,
    };
  const full = rt.readLine(it, se, Infinity);
  if (!full) return { ok: false, message: `${it.id} has nothing to read.` };
  const start = Math.max(0, Math.min(full.length, Math.floor(Number(from) || 0)));
  if (start >= full.length) return { ok: true, message: `Nothing after character ${count(full.length)}: that’s the end of ${it.id}.` };
  const end = Math.min(full.length, start + READING.part);
  if (start === 0 && end === full.length) return { ok: true, message: full };
  const more = end < full.length ? ` read_message { id: "${it.id}", from: ${end} } reads on.` : '';
  return { ok: true, message: `${full.slice(start, end)}\n\n(Characters ${count(start + 1)}–${count(end)} of ${count(full.length)}.${more})` };
}
