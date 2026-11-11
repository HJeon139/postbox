// The messages in the open conversation that match what's typed in Jump to… (#1233, which merged #866's own search
// into it). An item is found by the words it shows (shared/search-text.mjs), best first by BM25, and a hit jumps to
// it as Needs you does (focusItem), which waits for the item to be on the page and scrolls to it.

import { escapeRegExp } from '/shared/regex.mjs';
import { searchText } from '/shared/search-text.mjs';
import { itemIn } from './client.mjs';
import { h, icon } from './dom.mjs';
import { focusItem } from './needs-nav.mjs';
import { indexFor } from './transcript-search.mjs';

const HITS = 20;
const SNIPPET = 160;

/**
 * The part of an item’s text around its first matched word, with each matched word marked. Built from text nodes, so
 * nothing in an item’s text is read as HTML.
 * @param {string} text @param {string[]} terms
 */
export function snippet(text, terms) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const words = new RegExp(`\\b(${terms.map((t) => escapeRegExp(t)).join('|')})\\w*`, 'gi');
  const first = flat.search(words);
  const start = Math.max(0, first - SNIPPET / 3);
  const part = (start ? '…' : '') + flat.slice(start, start + SNIPPET) + (start + SNIPPET < flat.length ? '…' : '');
  /** @type {(string | HTMLElement)[]} */
  const out = [];
  let at = 0;
  for (const m of part.matchAll(words)) {
    out.push(part.slice(at, m.index), h('mark', m[0]));
    at = (m.index ?? 0) + m[0].length;
  }
  out.push(part.slice(at));
  return out;
}

/** Who said an item, for its hit. @param {any} it */
function speaker(it) {
  if (it.kind === 'user') return 'You';
  return it.handle ? `@${it.handle}` : 'Postbox';
}

/**
 * The palette’s rows for the messages in threadId that match q, best first. A hit for an item gone since the index
 * was written is skipped. @param {string} threadId @param {string} q
 */
export function messageRows(threadId, q) {
  return indexFor(threadId)
    .search(q, { k: HITS })
    .filter((x) => itemIn(threadId, x.id))
    .map((hit) => {
      const it = itemIn(threadId, hit.id);
      return {
        item: hit.id,
        content: [
          icon('comment', 'dim'),
          h('span.grow', h('span.small.dim', { style: { display: 'block' } }, speaker(it)), h('span', ...snippet(searchText(it), hit.terms))),
        ],
        run: () => void focusItem(hit.id),
      };
    });
}
