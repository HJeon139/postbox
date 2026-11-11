// A thread’s header facts (#1155): what the page shows about a conversation or a thread without loading its items. The
// rail, the Threads page, an agent’s open asks and a delete’s confirm read these, so opening the page costs the
// conversations and not their history. The server computes them from the store’s state and sends them with /api/state
// and on the stream (server/thread-headers.mjs).

import { ASKING } from './catalog.mjs';
import { itemOf } from './item-index.mjs';

/**
 * @typedef {{ id: string, sessionId: string, type: string }} OpenAsk
 * @typedef {{
 *   count: number,
 *   lastAt: number | null,
 *   speakers: string[],
 *   asks: OpenAsk[],
 *   blocks: Record<string, number>,
 *   root?: { replies: number, lastReplyAt: number | null },
 *   link?: { count: number, at: number | null, lastAt: number | null },
 * }} ThreadHeader
 */

/** Whether an item is an asking block still waiting for an answer, as an agent’s “1 open review” counts them (#69). */
const openAsk = (it) => it.kind === 'block' && it.valid && ASKING.has(it.block?.type) && !it.answered;

/**
 * The thread’s header: how many items it has and when the last came, who spoke in it, its open asking blocks, each
 * session’s blocks, and for a topic or side thread, the facts its conversation keeps about it (the message it
 * branched from, or the link to it).
 * @param {any} state @param {string} threadId
 * @returns {ThreadHeader}
 */
export function headerOf(state, threadId) {
  const list = state.items[threadId] ?? [];
  const speakers = new Set();
  /** @type {OpenAsk[]} */
  const asks = [];
  /** @type {Record<string, number>} */
  const blocks = {};
  for (const it of list) {
    if (it.kind === 'agent' && it.handle) speakers.add(it.handle);
    if (it.kind === 'block' && it.sessionId) blocks[it.sessionId] = (blocks[it.sessionId] ?? 0) + 1;
    if (openAsk(it)) asks.push({ id: it.id, sessionId: it.sessionId, type: it.block.type });
  }
  /** @type {ThreadHeader} */
  const header = { count: list.length, lastAt: list.at(-1)?.at ?? null, speakers: [...speakers], asks, blocks };
  const t = state.threads[threadId];
  const parent = t?.parentId ? (state.items[t.parentId] ?? []) : [];
  if (t?.kind === 'topic') {
    const root = itemOf(parent, t.rootItemId);
    header.root = { replies: root?.replies ?? 0, lastReplyAt: root?.lastReplyAt ?? null };
  }
  if (t?.kind === 'side') {
    const link = parent.find((x) => x.kind === 'sidelink' && x.sideThreadId === t.id);
    header.link = { count: link?.count ?? 0, at: link?.at ?? null, lastAt: link?.lastAt ?? null };
  }
  return header;
}
