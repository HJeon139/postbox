// A review block’s comments in one place: the threads on a line (or an app’s part), the person’s draft comments there,
// and the box a new one is written in. A comment on a selection (#179) shows the text it quotes, so it reads the same
// in Preview and in Lines, and an agent’s comment shows its handle (#133). Split out of app/js/review.mjs.

import { renderMarkdown } from '/shared/markdown.mjs';
import { h, icon, trusted } from './dom.mjs';

/** Whether a thread or a comment is on key: an app’s part, or a line. */
const on = (b, x, key) => (b.format === 'app' ? x.anchor === key : x.line === key);
/** The text a comment on a selection is about, as its meta line shows it. */
const quoted = (q) => (typeof q === 'string' ? h('q.rv-quote', q.length > 80 ? `${q.slice(0, 79)}…` : q) : null);

/**
 * @param {any} key  a line, an app’s part, or (in Preview) the anchor of a selection being commented on
 * @param {{ b: any, d: any, done: boolean, rerender: () => HTMLElement, closeComposer: (key: any) => void }} env
 * @returns {HTMLElement[]}
 */
export function threadBox(key, env) {
  const { b, d, done } = env;
  const parts = (b.threads ?? []).filter((t) => on(b, t, key)).map(threadOf);
  for (const c of d.comments.filter((x) => on(b, x, key))) parts.push(draftOf(c, env));
  if (!done && d.composing === key) parts.push(composer(key, env));
  return parts;
}

/** A thread the agent keeps on the block: who said what, and whether it’s resolved. @param {any} t */
function threadOf(t) {
  const resolved = t.status === 'resolved';
  return h(
    'div.rv-thread',
    { class: resolved ? 'resolved' : '' },
    t.comments.map((c, i) =>
      h(
        'div.c',
        h(
          'span.meta',
          h('b', c.author),
          i === 0 ? h('span.status-tag', { class: resolved ? 'ok' : 'open' }, resolved ? [icon('check', 'i-sm'), 'Resolved'] : 'Open') : null,
          i === 0 ? quoted(t.quote) : null,
        ),
        h('div', { html: trusted(renderMarkdown(c.text)) }),
      ),
    ),
  );
}

/** One of the person’s draft comments, until the review is sent. @param {any} c @param {any} env */
function draftOf(c, { d, done, rerender }) {
  const remove = () => {
    d.comments = d.comments.filter((x) => x !== c);
    rerender();
  };
  return h(
    'div.rv-thread',
    h(
      'div.c',
      h(
        'span.meta',
        h('b', 'You'),
        h('span.status-tag.draft', 'Draft'),
        // Its quote is gone from the text the agent revised (#179), or its line changed (#123).
        c.gone !== undefined ? h('span.status-tag', 'Its text changed') : c.moved ? h('span.status-tag', 'Its line changed') : null,
        quoted(c.quote ?? c.gone),
        done ? null : h('button.btn.sm.ghost', { type: 'button', style: { marginLeft: 'auto' }, onclick: remove }, 'Delete'),
      ),
      h('div', c.text),
    ),
  );
}

/** The box a new comment is written in, focused as it opens. @param {any} key @param {any} env */
function composer(key, { b, d, closeComposer }) {
  const label =
    typeof key === 'object'
      ? `Comment on “${key.quote.length > 60 ? `${key.quote.slice(0, 59)}…` : key.quote}”`
      : b.format === 'app'
        ? `Comment on ${key}`
        : `Comment on line ${key}`;
  const ta = h('textarea.textarea', {
    'aria-label': label,
    style: { minHeight: '56px' },
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        add();
      }
      // Escape closes the box, and only the box: not a full-screen review around it too.
      if (e.key === 'Escape') {
        e.preventDefault();
        closeComposer(key);
      }
    },
  });
  const add = () => {
    const text = ta.value.trim();
    if (!text) return;
    d.comments.push(typeof key === 'object' ? { ...key, text } : b.format === 'app' ? { anchor: key, text } : { line: key, text });
    closeComposer(key);
  };
  queueMicrotask(() => ta.focus());
  return h(
    'div.rv-thread',
    h(
      'div.reply',
      { style: { flexDirection: 'column' } },
      typeof key === 'object' ? h('span.small.dim', 'On ', quoted(key.quote)) : null,
      ta,
      h(
        'div.row-flex',
        h('button.btn.sm.send', { type: 'button', onclick: add }, 'Add draft comment'),
        h('button.btn.sm.ghost', { type: 'button', onclick: () => closeComposer(key) }, 'Cancel'),
        h('span.small.dim', 'Ctrl+Enter adds it'),
      ),
    ),
  );
}
