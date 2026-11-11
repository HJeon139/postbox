// Each conversation’s search index on the server (#1155), so the page’s search box finds items it hasn’t loaded. Built
// the first time a conversation is searched, then kept current as its items change, as the page’s own index was
// (shared/search-index.mjs): an add or a patch rewrites that item’s entry alone, and streamed text waits for the reply
// to finish. A Retry, which replaces the state, drops them all.

import { itemOf } from '../shared/item-index.mjs';
import { SearchIndex } from '../shared/search-index.mjs';
import { searchText } from '../shared/search-text.mjs';
import { publicItems } from './public-state.mjs';

/** @param {{ state: any, subscribe: (fn: (ev: any) => void) => void, onReload: (fn: () => void) => void }} store */
export function threadSearch(store) {
  /** @type {Map<string, SearchIndex>} */
  const indexes = new Map();
  /** @param {string} threadId @param {string} id */
  const reindex = (threadId, id) => indexes.get(threadId)?.put(id, searchText(itemOf(store.state.items[threadId] ?? [], id)));
  store.subscribe((ev) => {
    const d = ev.data ?? {};
    if (ev.type === 'remove' && d.kind === 'thread') indexes.delete(d.id);
    if (!indexes.has(d.threadId)) return;
    if (ev.type === 'item.add') reindex(d.threadId, d.item.id);
    else if (ev.type === 'item.patch') reindex(d.threadId, d.id);
    else if (ev.type === 'item.move') {
      reindex(d.threadId, d.id);
      reindex(d.threadId, d.stub.id);
    }
  });
  store.onReload(() => indexes.clear());
  return {
    /** A conversation’s index, if it has been searched: for the test that a change rewrites one entry. @param {string} threadId */
    indexOf: (threadId) => indexes.get(threadId) ?? null,
    /** The best matches in a conversation, best first. @param {string} threadId @param {string} q @param {number} k */
    search(threadId, q, k) {
      let ix = indexes.get(threadId);
      if (!ix) {
        ix = new SearchIndex();
        for (const it of publicItems(store.state, threadId) ?? []) ix.put(it.id, searchText(it));
        indexes.set(threadId, ix);
      }
      return ix.search(q, { k });
    },
  };
}
