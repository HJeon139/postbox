// A conversation’s items by range, and its search (#1155): the page loads what it draws, when it draws it, rather than
// every item of every conversation with /api/state. Both answer from the items as they reach the browser
// (server/public-state.mjs, publicItems), and carry the seq and epoch they’re as of, so the page applies only the stream’s
// events after them.

import { positionOf } from '../shared/item-index.mjs';
import { searchText } from '../shared/search-text.mjs';
import { clipText, httpError } from './helpers.mjs';
import { publicItems } from './public-state.mjs';

/** How many items a range has when the page asks for none, and the most it can ask for. */
export const PAGE = 100;
export const MOST = 500;
/** The most search hits, and the most of each hit’s text, that one answer carries. */
const HITS = 50;
const HIT_TEXT = 2000;

/**
 * Items [start, end) of a list for a request: the latest, or those before, after or around an item.
 * @param {any[]} list @param {URLSearchParams} q
 */
export function rangeOf(list, q) {
  const limit = Math.min(MOST, Math.max(1, Number(q.get('limit')) || PAGE));
  const total = list.length;
  const anchor = q.get('before') ?? q.get('after') ?? q.get('around');
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
    return { ...as, start, items: list.slice(start, end) };
  }
  const hits = search.search(threadId, url.searchParams.get('q') ?? '', HITS).map((hit) => {
    const it = list[positionOf(list, hit.id)];
    return { id: hit.id, terms: hit.terms, kind: it?.kind, handle: it?.handle ?? null, text: clipText(searchText(it), HIT_TEXT) };
  });
  return { ...as, hits };
}
