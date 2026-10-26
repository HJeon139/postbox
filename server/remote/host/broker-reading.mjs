// The snapshot’s reading tools on the host (#120): read_conversation and read_message answered by the daemon’s
// broker (broker.mjs) from the snapshot Postbox sent, as server/runtime.mjs answers them on the laptop.

import { READING } from '../../../shared/limits.mjs';
import { count } from './broker-state.mjs';

const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * @typedef {{ id: string, line: string, text: string, blockId?: string }} SnapshotItem
 * @typedef {{ turn?: string, home: string, threads: { id: string, items: SnapshotItem[] }[] }} Snapshot
 * @typedef {{ ok: boolean, text: string }} Answer
 */

/**
 * read_conversation from a snapshot: server/runtime.mjs’s readConversation, with the same limits, paging and words.
 * @param {Snapshot} snap @param {any} [args]
 * @returns {Answer}
 */
export function readConversation(snap, args = {}) {
  const { limit = 50, skip = 0, thread = null } = args ?? {};
  const id = typeof thread === 'string' && thread.trim() ? thread.trim().slice(0, 100) : snap.home;
  const th = snap.threads.find((t) => t.id === id);
  if (!th) return { ok: false, text: `There’s no thread ${id} in this conversation. Read one of its own threads: the id is in the catch-up line or the link.` };
  const items = th.items;
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const end = Math.max(0, items.length - Math.max(0, Number(skip) || 0));
  const slice = items.slice(Math.max(0, end - n), end);
  // Each line starts with its item’s id, which read_message and react take, as the laptop’s does.
  const lines = slice.flatMap((i) => (i.line ? [`[${i.id}] ${i.line}`] : []));
  const before = end - slice.length;
  return {
    ok: true,
    text: `${lines.join('\n\n') || 'The conversation is empty.'}${before ? `\n\n(${before} earlier ${before === 1 ? 'item' : 'items'}; call again with skip: ${items.length - before} to read them.)` : ''}`,
  };
}

/**
 * read_message from a snapshot: server/runtime.mjs’s readMessage, by item ID or a block’s ID, in parts of READING.part.
 * @param {Snapshot} snap @param {any} [args]
 * @returns {Answer}
 */
export function readMessage(snap, args = {}) {
  const { id, from = 0 } = args ?? {};
  const key = String(id ?? '').trim();
  if (!key) return { ok: false, text: 'Name the item: read_message { id }, with an id from your history or read_conversation.' };
  let it = snap.threads.map((th) => th.items.find((i) => i.id === key)).find(Boolean);
  if (!it) {
    const blocks = snap.threads.flatMap((th) => th.items.filter((i) => i.blockId === key));
    // The laptop names each block’s agent here; the snapshot carries only their item IDs.
    if (blocks.length > 1)
      return { ok: false, text: `More than one block is called “${key}”: they’re the items ${blocks.map((b) => b.id).join(', ')}. Read one by that id.` };
    it = blocks[0];
  }
  if (!it)
    return {
      ok: false,
      text: `There’s no item “${clipText(key, 80)}” in this conversation. Your history and read_conversation give the id of each item they cut.`,
    };
  const full = it.text;
  if (!full) return { ok: false, text: `${it.id} has nothing to read.` };
  const start = Math.max(0, Math.min(full.length, Math.floor(Number(from) || 0)));
  if (start >= full.length) return { ok: true, text: `Nothing after character ${count(full.length)}: that’s the end of ${it.id}.` };
  const end = Math.min(full.length, start + READING.part);
  if (start === 0 && end === full.length) return { ok: true, text: full };
  const more = end < full.length ? ` read_message { id: "${it.id}", from: ${end} } reads on.` : '';
  return { ok: true, text: `${full.slice(start, end)}\n\n(Characters ${count(start + 1)}–${count(end)} of ${count(full.length)}.${more})` };
}
