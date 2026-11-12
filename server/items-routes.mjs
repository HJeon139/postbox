// A conversation’s items by range, and its search (#1155): the page loads what it draws, when it draws it, rather than
// every item of every conversation with /api/state. Both answer from the items as they reach the browser
// (server/public-state.mjs, publicItems), and carry the seq and epoch they’re as of, so the page applies only the stream’s
// events after them.

import { positionOf } from '../shared/item-index.mjs';
import { needsYouNow, whereNeeds } from '../shared/needs.mjs';
import { searchText } from '../shared/search-text.mjs';
import { clipText, httpError } from './helpers.mjs';
import { publicItems } from './public-state.mjs';

/** How many items a range has when the page asks for none, and the most it can ask for but all of them. */
export const PAGE = 100;
export const MOST = 500;
/**
 * The most `limit=all` gives, the latest of them: a page with the transcript window off asks for every item, and a
 * million of them took the event loop most of a second and a 186 MB answer, or failed to fit a string. A conversation
 * longer than this opens with its window on, loading the rest at its edges (thread.mjs, createWindow).
 */
export const ALL_MOST = 20_000;
/** The longest search the server reads, in characters: each word of it is a pass over the conversation's index. */
export const QUERY_MOST = 500;
/** The most search hits, and the most of each hit’s text, that one answer carries. */
const HITS = 50;
const HIT_TEXT = 2000;

/**
 * Items [start, end) of a list for a request: the latest, the first (`first`, for Home), or those before, after or around
 * an item.
 * @param {any[]} list @param {URLSearchParams} q
 */
export function rangeOf(list, q) {
  // `all`: the whole conversation, up to ALL_MOST, for a page with the transcript window off. Otherwise a
  // whole number of items: a fractional limit would give fractional places, which slice() reads its own way.
  const all = q.get('limit') === 'all';
  const limit = all ? ALL_MOST : Math.min(MOST, Math.max(1, Math.floor(Number(q.get('limit'))) || PAGE));
  const total = list.length;
  const anchor = q.get('before') ?? q.get('after') ?? q.get('around');
  if (q.has('first')) return { start: 0, end: Math.min(total, limit) };
  if (anchor === null) return { start: Math.max(0, total - limit), end: total };
  const at = positionOf(list, anchor);
  if (at < 0) throw httpError(404, 'That message isn’t in this conversation. Reload the page to see it as it is now.');
  if (q.has('before')) return { start: Math.max(0, at - limit), end: at };
  if (q.has('after')) return { start: at + 1, end: Math.min(total, at + 1 + limit) };
  const end = Math.min(total, Math.max(0, at - Math.floor(limit / 2)) + limit);
  return { start: Math.max(0, end - limit), end };
}

/** A path's conversation id, decoded; one that isn't valid percent-encoding names no conversation. @param {string} raw */
function decodedId(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * The asks in a thread an agent's need or its “1 open choice” link goes to: each agent's need here, and the first of its
 * other open asks, at most two an agent, so what the page keeps of them doesn't grow with how often agents ask.
 * @param {any} state @param {string} threadId @param {{ id: string, sessionId: string }[]} open  the thread's open asks, in order
 */
export function asksIn(state, threadId, open) {
  const ids = new Set();
  for (const se of Object.values(state.sessions ?? {})) {
    if (!se || se.retiredFork) continue;
    const need = needsYouNow(se) && whereNeeds(state, se) === threadId ? se.needs.itemId : null;
    if (need) ids.add(need);
    const other = open.find((ask) => ask.sessionId === se.id && ask.id !== se.needs?.itemId);
    if (other) ids.add(other.id);
  }
  return ids;
}

/**
 * The `n` items around each of a thread's asks (asksIn) that [start, end) and the head don't hold: a jump to one, by ⌃J
 * or an agent's open-asks link, is placed with no load (#1155).
 * @param {any} state @param {string} threadId @param {any[]} list @param {{ id: string, sessionId: string }[]} open
 * @param {number} n @param {number} start @param {number} end @param {number} head
 */
function asksAround(state, threadId, list, open, n, start, end, head) {
  const kept = [];
  for (const id of asksIn(state, threadId, open)) {
    const at = positionOf(list, id);
    if (at < 0 || (at >= start && at < end) || at < head) continue;
    const r = rangeOf(list, new URLSearchParams({ around: id, limit: String(n) }));
    kept.push({ id, start: r.start, items: list.slice(r.start, r.end) });
  }
  return kept;
}

/**
 * GET /api/threads/:id/items and /api/threads/:id/search, or null for any other request.
 * @param {{ state: any, epoch: string }} store @param {{ search: (threadId: string, q: string, k: number) => any[] }} search
 * @param {string} path @param {string | undefined} method @param {URL} url
 * @param {{ of: (threadId: string) => { asks: { id: string, sessionId: string }[] } | null }} [headers]  the threads' headers, for `asks`
 */
export function itemsRoute(store, search, path, method, url, headers) {
  const m = method === 'GET' ? path.match(/^\/api\/threads\/([^/]+)\/(items|search)$/) : null;
  if (!m) return null;
  const threadId = decodedId(m[1]);
  const list = threadId !== null && store.state.threads[threadId] ? publicItems(store.state, threadId) : null;
  if (threadId === null || !list) throw httpError(404, 'That conversation doesn’t exist. It may have been deleted.');
  const as = { seq: store.state.seq, epoch: store.epoch, threadId, total: list.length };
  if (m[2] === 'items') {
    const { start, end } = rangeOf(list, url.searchParams);
    // head=N: a range that doesn't start at the first item comes with the first N, at most MOST, for Home (#1155).
    const head = Math.min(MOST, Math.max(0, Math.floor(Number(url.searchParams.get('head'))) || 0));
    // asks=N: with the N items around each open ask the answer doesn't hold, at most MOST, for ⌃J and the open-asks link.
    const n = Math.min(MOST, Math.max(0, Math.floor(Number(url.searchParams.get('asks'))) || 0));
    const open = n && headers ? (headers.of(threadId)?.asks ?? []) : [];
    const asks = n ? asksAround(store.state, threadId, list, open, n, start, end, start > 0 ? head : 0) : [];
    return {
      ...as,
      start,
      items: list.slice(start, end),
      ...(head && start > 0 ? { head: list.slice(0, head) } : {}),
      ...(asks.length ? { asks } : {}),
    };
  }
  const hits = search.search(threadId, (url.searchParams.get('q') ?? '').slice(0, QUERY_MOST), HITS).map((hit) => {
    const it = list[positionOf(list, hit.id)];
    return { id: hit.id, terms: hit.terms, kind: it?.kind, handle: it?.handle ?? null, text: clipText(searchText(it), HIT_TEXT) };
  });
  return { ...as, hits };
}
