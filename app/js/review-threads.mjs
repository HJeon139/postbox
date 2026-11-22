// A review block’s comments in one place: the threads on a line (or an app’s part), the person’s draft comments there,
// and the box a new one is written in. A comment on a selection (#179) shows the text it quotes, so it reads the same
// in Preview and in Lines, and an agent’s comment shows its handle (#133). Split out of app/js/review.mjs.

import { renderMarkdown } from '/shared/markdown.mjs';
import { authorName } from '/shared/review-comments.mjs';
import { h, icon, plural, trusted } from './dom.mjs';
import { parkComment, saveEdit } from './review-draft.mjs';
import { revisionOf } from './review-view.mjs';

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
          // An agent’s comment is stored with its handle as @handle, and shows the name alone; the person’s shows You.
          h('b', authorName(c.author).replace(/^@/, '')),
          i === 0 ? h('span.status-tag', { class: resolved ? 'ok' : 'open' }, resolved ? [icon('check', 'i-sm'), 'Resolved'] : 'Open') : null,
          i === 0 ? quoted(t.quote) : null,
        ),
        h('div', { html: trusted(renderMarkdown(c.text)) }),
      ),
    ),
  );
}

/**
 * One of the person’s draft comments, until the review is sent: Edit opens it in place (#858), Delete drops it. Which
 * one is open is kept by its place in the draft, which revising the text under it (followLines) keeps.
 * @param {any} c @param {any} env
 */
function draftOf(c, env) {
  const { d, done, rerender } = env;
  const at = d.comments.indexOf(c);
  if (!done && d.editing === at) return editorOf(c, at, env);
  const remove = () => {
    d.comments = d.comments.filter((x) => x !== c);
    // The one open for editing keeps its place when one before it goes.
    if (typeof d.editing === 'number' && d.editing > at) d.editing--;
    rerender();
  };
  // One box at a time: a new comment’s box closes, and another edit keeps what was typed in it.
  const edit = () => {
    parkComment(d);
    saveEdit(d);
    d.editFocus = true;
    d.editing = at;
    d.editingText = d.comments[at].text;
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
        done ? null : h('button.btn.sm.ghost', { type: 'button', style: { marginLeft: 'auto' }, 'data-draft': String(at), onclick: edit }, 'Edit'),
        done ? null : h('button.btn.sm.ghost', { type: 'button', onclick: remove }, 'Delete'),
      ),
      h('div', c.text),
    ),
  );
}

/**
 * A draft comment open for editing, with its text, on the same line, selection or part: saving replaces its text and
 * keeps where it is; Cancel or Escape leaves it as it was. Either way focus goes back to its Edit button.
 * @param {any} c @param {number} at  its place in the draft @param {any} env
 */
function editorOf(c, at, { d, rerender }) {
  const close = (/** @type {boolean} */ save) => {
    if (save && !ta.value.trim()) return;
    if (save) d.editingText = ta.value;
    else d.editingText = '';
    saveEdit(d);
    /** @type {HTMLElement | null} */ (rerender().querySelector(`[data-draft="${at}"]`))?.focus();
  };
  const text = typeof d.editingText === 'string' ? d.editingText : c.text;
  const saved = Array.isArray(d.editingSelection) ? d.editingSelection : [text.length, text.length];
  // Its text and caret are kept, so a repaint while it’s open (another agent’s comment, a revision) leaves both.
  const remember = () => {
    d.editingText = ta.value;
    d.editingSelection = [ta.selectionStart, ta.selectionEnd];
  };
  const ta = h('textarea.textarea', {
    'aria-label': 'Edit your draft comment',
    'data-edit-draft': '',
    style: { minHeight: '56px' },
    value: text,
    oninput: remember,
    onselect: remember,
    onkeyup: remember,
    onmouseup: remember,
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        close(true);
      }
      // Escape closes the box, and only the box: not a full-screen review around it too.
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
    },
  });
  // Focus goes to it when Edit is pressed, and back to it after a repaint only if it had focus: a repaint while the
  // person types elsewhere, such as another agent’s comment arriving, leaves their focus where it is.
  const focused = d.editFocus || document.activeElement?.matches('textarea[data-edit-draft]');
  d.editFocus = false;
  if (focused) queueMicrotask(() => restoreComposer(ta, saved, text));
  const quote = quoted(c.quote ?? c.gone);
  return h(
    'div.rv-thread',
    h(
      'div.reply',
      { style: { flexDirection: 'column' } },
      quote ? h('span.small.dim', 'On ', quote) : null,
      ta,
      h(
        'div.row-flex',
        h('button.btn.sm.send', { type: 'button', onclick: () => close(true) }, 'Save comment'),
        h('button.btn.sm.ghost', { type: 'button', onclick: () => close(false) }, 'Cancel'),
        h('span.small.dim', 'Ctrl+Enter saves it'),
      ),
    ),
  );
}

/** Restores focus and the saved selection after the box is rebuilt. */
function restoreComposer(ta, saved, text) {
  ta.focus();
  const start = Math.min(saved[0] ?? text.length, text.length);
  ta.setSelectionRange(start, Math.min(saved[1] ?? start, text.length));
}

/** The box a new comment is written in, focused as it opens. @param {any} key @param {any} env */
function composer(key, { b, d, closeComposer }) {
  const label =
    typeof key === 'object'
      ? `Comment on “${key.quote.length > 60 ? `${key.quote.slice(0, 59)}…` : key.quote}”`
      : b.format === 'app'
        ? `Comment on ${key}`
        : `Comment on line ${key}`;
  const text = typeof d.composingText === 'string' ? d.composingText : '';
  const saved = Array.isArray(d.composingSelection) ? d.composingSelection : [text.length, text.length];
  const remember = () => {
    d.composingText = ta.value;
    d.composingSelection = [ta.selectionStart, ta.selectionEnd];
  };
  const ta = h('textarea.textarea', {
    'aria-label': label,
    style: { minHeight: '56px' },
    value: text,
    oninput: remember,
    onselect: remember,
    onkeyup: remember,
    onmouseup: remember,
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
  queueMicrotask(() => restoreComposer(ta, saved, text));
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

const VERDICTS = { comment: 'Comment', approve: 'Approve', request_changes: 'Request changes' };
/**
 * Who else reviewed the draft (#133), for its review bar: “2 comments from @critic (Request changes)”. Their comments
 * are threads on it; their verdict doesn’t answer it. @param {any} item @param {any} b
 */
export function reviewersOf(item, b) {
  /** @type {Map<string, { n: number, verdict?: string, revision: number }>} */
  const by = new Map();
  for (const r of item.reviews ?? []) {
    // The person’s own review (#1143) is their answer, not a reviewer’s.
    if (r.person) continue;
    const was = by.get(r.handle);
    by.set(r.handle, { n: (was?.n ?? 0) + r.threads.length, verdict: r.verdict ?? was?.verdict, revision: r.revision });
  }
  const said = [...by].map(([handle, r]) => {
    const on = r.revision !== revisionOf(item, b) ? `, on v${r.revision}` : '';
    return `${plural(r.n, 'comment')} from ${handle}${r.verdict ? ` (${VERDICTS[r.verdict] ?? r.verdict})` : ''}${on}`;
  });
  return said.length ? h('span.rv-reviewers', ' · ', said.join(' · ')) : null;
}
