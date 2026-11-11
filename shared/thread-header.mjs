// A thread’s header facts (#1155): what the page shows about a conversation or a thread without loading its items. The
// rail, the Threads page, an agent’s open asks and a delete’s confirm read these, so opening the page costs the
// conversations and not their history. The server keeps them, updated from each event (server/thread-headers.mjs), and
// sends them with /api/state and on the stream; headerOf here walks a thread whole, the reference they’re tested against.

import { ASKING } from './catalog.mjs';
import { itemOf, positionOf } from './item-index.mjs';

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
 * @typedef {{ count: number, lastAt: number | null, speakers: Set<string>, asks: Map<string, OpenAsk>, blocks: Record<string, number> }} Facts
 */

/** Whether an item is an asking block still waiting for an answer, as an agent’s “1 open review” counts them (#69). */
export const openAsk = (/** @type {any} */ it) => !!it && it.kind === 'block' && it.valid && ASKING.has(it.block?.type) && !it.answered;

/** A thread’s own facts, with none of its items yet. @returns {Facts} */
export const noFacts = () => ({ count: 0, lastAt: null, speakers: new Set(), asks: new Map(), blocks: {} });

/** Counts one item added at the end of a thread into its facts. @param {Facts} f @param {any} it */
export function addItem(f, it) {
  f.count++;
  f.lastAt = it.at ?? null;
  if (it.kind === 'agent' && it.handle) f.speakers.add(it.handle);
  if (it.kind === 'block' && it.sessionId) f.blocks[it.sessionId] = (f.blocks[it.sessionId] ?? 0) + 1;
  checkAsk(f, it);
}

/** Whether an item is one of the facts’ open asks, as it is now. @param {Facts} f @param {any} it */
export function checkAsk(f, it) {
  if (openAsk(it)) f.asks.set(it.id, { id: it.id, sessionId: it.sessionId, type: it.block.type });
  else if (it) f.asks.delete(it.id);
}

/**
 * The header the page sees: the facts, the open asks in the thread’s order, and for a topic or side thread the facts its
 * conversation keeps about it (the message it branched from, or the link to it).
 * @param {Facts} f @param {any[]} list @param {any} root  the topic’s root item @param {any} link  the side thread’s link
 * @param {string | undefined} kind @returns {ThreadHeader}
 */
export function headerFrom(f, list, root, link, kind) {
  const asks = [...f.asks.values()].sort((a, b) => positionOf(list, a.id) - positionOf(list, b.id));
  /** @type {ThreadHeader} */
  const header = { count: f.count, lastAt: f.lastAt, speakers: [...f.speakers], asks, blocks: { ...f.blocks } };
  if (kind === 'topic') header.root = { replies: root?.replies ?? 0, lastReplyAt: root?.lastReplyAt ?? null };
  if (kind === 'side') header.link = { count: link?.count ?? 0, at: link?.at ?? null, lastAt: link?.lastAt ?? null };
  return header;
}

/**
 * The thread’s header, walking its items whole.
 * @param {any} state @param {string} threadId
 * @returns {ThreadHeader}
 */
export function headerOf(state, threadId) {
  const list = state.items[threadId] ?? [];
  const f = noFacts();
  for (const it of list) addItem(f, it);
  const t = state.threads[threadId];
  const parent = t?.parentId ? (state.items[t.parentId] ?? []) : [];
  const root = t?.kind === 'topic' ? itemOf(parent, t.rootItemId) : null;
  const link = t?.kind === 'side' ? parent.find((x) => x.kind === 'sidelink' && x.sideThreadId === t.id) : null;
  return headerFrom(f, list, root, link, t?.kind);
}
