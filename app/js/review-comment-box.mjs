// A review’s comment box, the new comment’s, a draft’s open for editing, and a sent comment’s correction (#858): its
// text and caret kept over a repaint, its keys, and when it takes focus; and how a comment’s place reads in its box
// and buttons.

import { h } from './dom.mjs';

/**
 * Where a comment is, as its box and buttons name it (#858): “line 3”, an app’s part, or the text a selection quotes.
 * @param {any} at  a line, a part, or a selection with its quote @param {any} b
 */
export function placeOf(at, b) {
  if (typeof at === 'object') return `“${at.quote.length > 60 ? `${at.quote.slice(0, 59)}…` : at.quote}”`;
  return b.format === 'app' ? at : `line ${at}`;
}
/** A draft comment’s place, as placeOf takes it. @param {any} c @param {any} b */
export function placeKey(c, b) {
  if (typeof c.quote === 'string') return c;
  return b.format === 'app' ? c.anchor : c.line;
}
/** The text a comment on a selection is about, as its meta line shows it. */
export const quoted = (q) => (typeof q === 'string' ? h('q.rv-quote', q.length > 80 ? `${q.slice(0, 79)}…` : q) : null);

/** Each comment box’s review draft, so a repaint finds only its own box (refocus). */
const ownerOf = new WeakMap();

/**
 * Gives a comment box focus, with its saved selection, when it was just opened (`d[opened]`), or after a repaint only
 * if it had focus (#858): a repaint while the person types elsewhere, such as another agent’s comment arriving, leaves
 * their focus where it is. It had focus if its old box, `mark` in this review, still has it, or if nothing does and
 * this box had it last: a resync takes the old box off the page before the new one is built.
 * @param {HTMLTextAreaElement} ta @param {any} d @param {string} opened @param {string} mark @param {number[]} saved
 * @param {string} text
 */
function refocus(ta, d, opened, mark, saved, text) {
  ownerOf.set(ta, d);
  const active = document.activeElement;
  const nowhere = !active || active === document.body;
  const had = d.focusedBox === mark && (nowhere || (ownerOf.get(active) === d && active.hasAttribute(mark)));
  const open = d[opened] || had;
  d[opened] = false;
  if (open) queueMicrotask(() => restoreComposer(ta, saved, text));
}

/**
 * Keeps which box has focus on its draft. Focus moving to another control clears it; the box leaving the page, or the
 * window losing focus, doesn’t. @param {any} d @param {string} mark
 */
const tracked = (d, mark) => ({
  [mark]: '',
  onfocus: () => {
    d.focusedBox = mark;
  },
  onblur: (/** @type {FocusEvent} */ e) => {
    if (e.relatedTarget) d.focusedBox = null;
  },
});

/** Restores focus and the saved selection after the box is rebuilt. */
function restoreComposer(ta, saved, text) {
  ta.focus();
  const start = Math.min(saved[0] ?? text.length, text.length);
  ta.setSelectionRange(start, Math.min(saved[1] ?? start, text.length));
}

/**
 * A review comment box: the new comment’s, and a draft’s open for editing (#858). Its text and caret are kept on the
 * draft, in the two fields `fields` names, so a repaint while it’s open (another agent’s comment, a revision) leaves
 * both; Ctrl+Enter saves it and Escape cancels it; and it takes focus as refocus says.
 * @param {any} d
 * @param {{ label: string, mark: string, opened: string, fields: [string, string], text: string, quote: HTMLElement | null,
 *   saveLabel: string, hint: string, onSave: (value: string) => void, onCancel: () => void }} box
 */
export function commentBox(d, box) {
  const [textField, selectionField] = box.fields;
  const saved = Array.isArray(d[selectionField]) ? d[selectionField] : [box.text.length, box.text.length];
  const remember = () => {
    d[textField] = ta.value;
    d[selectionField] = [ta.selectionStart, ta.selectionEnd];
  };
  const ta = h('textarea.textarea', {
    'aria-label': box.label,
    ...tracked(d, box.mark),
    style: { minHeight: '56px' },
    value: box.text,
    oninput: remember,
    onselect: remember,
    onkeyup: remember,
    onmouseup: remember,
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        box.onSave(ta.value);
      }
      // Escape closes the box, and only the box: not a full-screen review around it too.
      if (e.key === 'Escape') {
        e.preventDefault();
        box.onCancel();
      }
    },
  });
  refocus(ta, d, box.opened, box.mark, saved, box.text);
  return h(
    'div.rv-thread',
    h(
      'div.reply',
      { style: { flexDirection: 'column' } },
      box.quote ? h('span.small.dim', 'On ', box.quote) : null,
      ta,
      h(
        'div.row-flex',
        h('button.btn.sm.send', { type: 'button', onclick: () => box.onSave(ta.value) }, box.saveLabel),
        h('button.btn.sm.ghost', { type: 'button', onclick: box.onCancel }, 'Cancel'),
        h('span.small.dim', box.hint),
      ),
    ),
  );
}
