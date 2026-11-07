// Each conversation’s search index (#866, W4), built the first time search opens in it, so a switch costs nothing
// new, then kept current as items change: an add or a patch rewrites that item’s entry alone, and a reply is indexed
// once it’s done, not per streamed delta. A reload drops them all.

import { SearchIndex } from '/shared/search-index.mjs';
import { searchText } from '/shared/search-text.mjs';
import { client, itemIn, itemsOf } from './client.mjs';

/** @type {Map<string, SearchIndex>} */
const indexes = new Map();

/** The index for a conversation’s items, built now if search hasn’t opened in it yet. @param {string} threadId */
export function indexFor(threadId) {
  let ix = indexes.get(threadId);
  if (ix) return ix;
  ix = new SearchIndex();
  for (const it of itemsOf(threadId)) ix.put(it.id, searchText(it));
  indexes.set(threadId, ix);
  return ix;
}

/** An item’s entry, in a conversation that has an index. @param {string} threadId @param {string} id */
function reindex(threadId, id) {
  const ix = indexes.get(threadId);
  if (!ix) return;
  ix.put(id, searchText(itemIn(threadId, id)));
}

client.on((/** @type {any} */ ch) => {
  if (ch.type === 'load') return indexes.clear();
  const d = ch.data;
  if (!d?.threadId || !indexes.has(d.threadId)) return;
  if (ch.type === 'item.add') reindex(d.threadId, d.item.id);
  else if (ch.type === 'item.patch') reindex(d.threadId, d.id);
  else if (ch.type === 'item.move') {
    reindex(d.threadId, d.id);
    reindex(d.threadId, d.stub.id);
  }
});
