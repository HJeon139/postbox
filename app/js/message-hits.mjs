// The messages in the open conversation that match what's typed in Jump to… (#1233, which merged #866's own search
// into it). The server searches (/api/threads/:id/search, #1155), so it finds items the page hasn't loaded: an item is
// found by the words it shows (shared/search-text.mjs), best first by BM25, and a hit jumps to it as Needs you does
// (focusItem), which loads the range around it, waits for it to be on the page and scrolls to it.

import { escapeRegExp } from '/shared/regex.mjs';
import { h, icon } from './dom.mjs';
import { focusItem } from './needs-nav.mjs';

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

/** Who said an item, for its hit. @param {{ kind?: string, handle?: string | null }} hit */
function speaker(hit) {
  if (hit.kind === 'user') return 'You';
  return hit.handle ? `@${hit.handle}` : 'Postbox';
}

/** @typedef {{ id: string, terms: string[], kind?: string, handle?: string | null, text: string }} Hit */

/**
 * The palette’s rows for the messages in threadId that match q, best first, from the server. A newer query aborts the
 * one before through `signal`. @param {string} threadId @param {string} q @param {AbortSignal} signal
 */
export async function messageRows(threadId, q, signal) {
  const r = await fetch(`/api/threads/${encodeURIComponent(threadId)}/search?q=${encodeURIComponent(q)}`, { cache: 'no-store', signal });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Search didn’t answer. Try again.');
  /** @type {Hit[]} */
  const hits = (await r.json()).hits.slice(0, HITS);
  return hits.map((hit) => ({
    item: hit.id,
    content: [
      icon('comment', 'dim'),
      h('span.grow', h('span.small.dim', { style: { display: 'block' } }, speaker(hit)), h('span', ...snippet(hit.text, hit.terms))),
    ],
    run: () => void focusItem(hit.id, threadId),
  }));
}

/**
 * Asks the server for a conversation's messages one query at a time: a newer query aborts the one before, whose rows
 * then never come, and an empty one asks nothing. onRows gets each answer. pending() is the answer still coming, if any.
 * @param {string} threadId @param {(q: string, rows: Awaited<ReturnType<typeof messageRows>>) => void} onRows
 */
export function messageAsker(threadId, onRows) {
  /** @type {{ abort: AbortController, done: Promise<void> } | null} */
  let current = null;
  const stop = () => {
    current?.abort.abort();
    current = null;
  };
  return {
    stop,
    pending: () => current?.done ?? null,
    /** @param {string} q */
    ask(q) {
      stop();
      if (!q) return;
      const abort = new AbortController();
      /** @type {{ abort: AbortController, done: Promise<void> }} */
      const mine = { abort, done: Promise.resolve() };
      // Whether this is still the latest query, which it no longer waits on once it answers.
      const settle = () => {
        if (current !== mine) return false;
        current = null;
        return true;
      };
      mine.done = messageRows(threadId, q, abort.signal).then(
        (rows) => {
          if (settle()) onRows(q, rows);
        },
        () => void settle(),
      );
      current = mine;
    },
  };
}
