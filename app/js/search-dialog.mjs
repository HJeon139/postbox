// Search the open conversation (#866, W4; the person’s choice of 6 Nov): the top bar’s Search button, or ⌘⇧F
// (Ctrl+Shift+F elsewhere), opens it. ⌘F stays the browser’s own find. It finds an item by the words it shows
// (shared/search-text.mjs), best first by BM25, and Enter or a click jumps to it as Needs you does (focusItem), which
// draws it if the page hasn’t. A query runs at most once a frame while you type.

import { escapeRegExp } from '/shared/regex.mjs';
import { searchText } from '/shared/search-text.mjs';
import { itemIn } from './client.mjs';
import { h, icon } from './dom.mjs';
import { focusItem } from './needs-nav.mjs';
import { indexFor } from './transcript-search.mjs';
import { openDialog, route } from './ui.mjs';

const HITS = 20;
const SNIPPET = 160;

/** Whether this key press is the search shortcut. @param {KeyboardEvent} e */
export const isSearchKey = (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f';

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

/** The top bar’s Search button, for a conversation (null elsewhere): it finds messages the page hasn’t drawn, which ⌘F can’t. @param {any} t */
export const searchButton = (t) =>
  t
    ? h(
        'button.btn.icon.sm.ghost',
        {
          type: 'button',
          id: 'search-button',
          'aria-label': 'Search this conversation',
          'aria-keyshortcuts': 'Meta+Shift+F Control+Shift+F',
          onclick: openSearch,
        },
        icon('search'),
      )
    : null;

/** One hit in the list. @param {string} threadId @param {{ id: string, terms: string[] }} hit @param {boolean} chosen @param {number} i @param {(id: string) => void} go */
function hitRow(threadId, hit, chosen, i, go) {
  const it = itemIn(threadId, hit.id);
  return h(
    'li',
    { role: 'option', id: `sr-${i}`, 'aria-selected': String(chosen), dataset: { item: hit.id }, onclick: () => go(hit.id) },
    h('span.grow', h('span.small.dim', { style: { display: 'block' } }, speaker(it)), h('span', ...snippet(searchText(it), hit.terms))),
  );
}

/** What a query says it found. @param {string} q @param {number} n */
function found(q, n) {
  if (!q) return '';
  if (!n) return 'Nothing found';
  return n === HITS ? `Top ${n} found` : `${n} found`;
}

/** Opens search for the conversation on screen; again while open, goes back to its field. */
export function openSearch() {
  const open = /** @type {HTMLInputElement | null} */ (document.querySelector('.dialog.search-dialog input'));
  if (open) return open.focus();
  const r = route();
  const threadId = r.view === 'thread' ? r.threadId : null;
  if (!threadId) return;
  const index = indexFor(threadId);
  const input = h('input.input', {
    type: 'search',
    'aria-label': 'Search this conversation',
    placeholder: 'Search this conversation…',
    role: 'combobox',
    'aria-controls': 'sr-list',
    'aria-expanded': 'true',
    'aria-autocomplete': 'list',
    autocomplete: 'off',
  });
  const list = h('ul.p-list', { id: 'sr-list', role: 'listbox', 'aria-label': 'Results' });
  const status = h('p.small.dim', { role: 'status' });
  /** @type {{ id: string, terms: string[] }[]} */
  let hits = [];
  let sel = 0;
  let queued = 0;
  const go = (/** @type {string} */ id) => {
    dlg.close();
    void focusItem(id);
  };
  const paint = () => {
    list.replaceChildren(...hits.map((hit, i) => hitRow(threadId, hit, i === sel, i, go)));
    if (hits.length) input.setAttribute('aria-activedescendant', `sr-${sel}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const run = () => {
    queued = 0;
    const q = input.value.trim();
    // A hit for an item gone since the index was written is skipped.
    hits = q ? index.search(q, { k: HITS }).filter((x) => itemIn(threadId, x.id)) : [];
    sel = 0;
    status.textContent = found(q, hits.length);
    paint();
  };
  input.addEventListener('input', () => {
    if (!queued) queued = requestAnimationFrame(run);
  });
  input.addEventListener('keydown', (e) => {
    if (!hits.length || !['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Enter') return go(hits[sel].id);
    sel = (sel + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
    paint();
  });
  const dlg = openDialog({ title: 'Search this conversation', body: [input, status, list], size: 'palette', initialFocus: () => input });
  dlg.dialog.classList.add('search-dialog');
}
