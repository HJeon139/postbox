// A conversation’s items by range, and its search (#1155): the page loads what it draws, when it draws it, rather than
// every item of every conversation with /api/state. Both answer from the items as they reach the browser
// (server/public-state.mjs, publicItems), and carry the seq and epoch they’re as of, so the page applies only the stream’s
// events after them.

import { positionOf } from '../shared/item-index.mjs';
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
 * GET /api/threads/:id/items and /api/threads/:id/search, or null for any other request.
 * @param {{ state: any, epoch: string }} store @param {{ search: (threadId: string, q: string, k: number) => any[] }} search
 * @param {string} path @param {string | undefined} method @param {URL} url
 */
export function itemsRoute(store, search, path, method, url) {
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
    return { ...as, start, items: list.slice(start, end), ...(head && start > 0 ? { head: list.slice(0, head) } : {}) };
  }
  const hits = search.search(threadId, (url.searchParams.get('q') ?? '').slice(0, QUERY_MOST), HITS).map((hit) => {
    const it = list[positionOf(list, hit.id)];
    return { id: hit.id, terms: hit.terms, kind: it?.kind, handle: it?.handle ?? null, text: clipText(searchText(it), HIT_TEXT) };
  });
  return { ...as, hits };
}
