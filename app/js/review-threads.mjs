// A review block’s comments in one place: the threads on a line (or an app’s part), the person’s draft comments there,
// and the box a new one is written in. A comment on a selection (#179) shows the text it quotes, so it reads the same
// in Preview and in Lines, and an agent’s comment shows its handle (#133). Split out of app/js/review.mjs.

import { renderMarkdown } from '/shared/markdown.mjs';
import { authorName } from '/shared/review-comments.mjs';
import { h, icon, plural, trusted } from './dom.mjs';
import { commentBox, placeKey, placeOf, quoted } from './review-comment-box.mjs';
import { correctButton, correctingIn, correctionBox, lastMine } from './review-correct.mjs';
import { commentAt, parkComment, saveEdit } from './review-draft.mjs';
import { revisionOf } from './review-view.mjs';

/** Whether a thread or a comment is on key: an app’s part, or a line. */
const on = (b, x, key) => (b.format === 'app' ? x.anchor === key : x.line === key);
/**
 * @param {any} key  a line, an app’s part, or (in Preview) the anchor of a selection being commented on
 * @param {{ b: any, d: any, done: boolean, rerender: () => HTMLElement, closeComposer: (key: any) => void }} env
 * @returns {HTMLElement[]}
 */
export function threadBox(key, env) {
  const { b, d, done } = env;
  const parts = (b.threads ?? []).filter((t) => on(b, t, key)).map((t) => threadOf(t, env));
  for (const c of d.comments.filter((x) => on(b, x, key))) parts.push(draftOf(c, env));
  if (!done && d.composing === key) parts.push(composer(key, env));
  return parts;
}

/**
 * A thread the agent keeps on the block: who said what, and whether it’s resolved. The person’s last comment in it has
 * Edit, which corrects it (#858); a correction shows as edited, after what they sent. @param {any} t @param {any} env
 */
function threadOf(t, env) {
  const resolved = t.status === 'resolved';
  const mine = lastMine(t);
  const open = !env.closed && correctingIn(env.itemId) === t.id;
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
          c.edited ? h('span.status-tag', 'Edited') : null,
          i === mine && !open && !env.closed ? correctButton(t, env) : null,
        ),
        h('div', { html: trusted(renderMarkdown(c.text)) }),
      ),
    ),
    open ? correctionBox(t, env) : null,
  );
}

/**
 * One of the person’s draft comments, until the review is sent: Edit opens it in place (#858), Delete drops it. Which
 * one is open is kept by its place in the draft, which revising the text under it (followLines) keeps.
 * @param {any} c @param {any} env
 */
function draftOf(c, env) {
  const { b, d, done, rerender } = env;
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
        // Each names its comment’s place, so a screen reader tells one draft’s buttons from another’s.
        done
          ? null
          : h(
              'button.btn.sm.ghost',
              {
                type: 'button',
                style: { marginLeft: 'auto' },
                'aria-label': `Edit your comment on ${placeOf(placeKey(c, b), b)}`,
                'data-draft': String(at),
                onclick: edit,
              },
              'Edit',
            ),
        done
          ? null
          : h('button.btn.sm.ghost', { type: 'button', 'aria-label': `Delete your comment on ${placeOf(placeKey(c, b), b)}`, onclick: remove }, 'Delete'),
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
function editorOf(c, at, { b, d, rerender }) {
  const close = (/** @type {string | null} */ value) => {
    if (value !== null && !value.trim()) return;
    d.editingText = value ?? '';
    saveEdit(d);
    /** @type {HTMLElement | null} */ (rerender().querySelector(`[data-draft="${at}"]`))?.focus();
  };
  return commentBox(d, {
    label: `Edit your comment on ${placeOf(placeKey(c, b), b)}`,
    mark: 'data-edit-draft',
    opened: 'editFocus',
    fields: ['editingText', 'editingSelection'],
    text: typeof d.editingText === 'string' ? d.editingText : c.text,
    quote: quoted(c.quote ?? c.gone),
    saveLabel: 'Save comment',
    hint: 'Ctrl+Enter saves it',
    onSave: (value) => close(value),
    onCancel: () => close(null),
  });
}

/** The box a new comment is written in, focused as it opens. @param {any} key @param {any} env */
function composer(key, { b, d, closeComposer }) {
  const add = (/** @type {string} */ value) => {
    const text = value.trim();
    if (!text) return;
    d.comments.push(commentAt(key, text, b.format === 'app'));
    closeComposer(key);
  };
  return commentBox(d, {
    label: `Comment on ${placeOf(key, b)}`,
    mark: 'data-new-comment',
    opened: 'composeFocus',
    fields: ['composingText', 'composingSelection'],
    text: typeof d.composingText === 'string' ? d.composingText : '',
    quote: typeof key === 'object' ? quoted(key.quote) : null,
    saveLabel: 'Add draft comment',
    hint: 'Ctrl+Enter adds it',
    onSave: add,
    onCancel: () => closeComposer(key),
  });
}

const VERDICTS = { comment: 'Comment', approve: 'Approve', request_changes: 'Request changes' };
/** A verdict’s label, by an own key only: a name every object inherits shows as given. */
const verdictLabel = (v) => (Object.hasOwn(VERDICTS, v) ? VERDICTS[v] : v);
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
    return `${plural(r.n, 'comment')} from ${handle}${r.verdict ? ` (${verdictLabel(r.verdict)})` : ''}${on}`;
  });
  return said.length ? h('span.rv-reviewers', ' · ', said.join(' · ')) : null;
}
