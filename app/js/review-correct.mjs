// The person corrects a comment of theirs on a review they submitted (#858). What they sent stays in its thread,
// since the agent has read it; Edit opens a box with its text, and Send correction adds the new text after it, marked
// edited, as server/review-correct.mjs records it. Its state is kept here by the review’s item, not on the review’s
// draft, which a submit replaces.

import { PERSON } from '/shared/review-comments.mjs';
import { h, icon } from './dom.mjs';
import { commentBox, placeKey, placeOf } from './review-comment-box.mjs';

/** Each review’s correction: which thread’s is open, its box’s text and caret, and why the last one was refused. */
const states = new Map();
/** The correction state of the review with item id `id`, as commentBox keeps a box’s. @param {string} id */
export function correctionOf(id) {
  if (!states.has(id))
    states.set(id, {
      correcting: null,
      correctingText: '',
      correctingSelection: null,
      correctFocus: false,
      focusedBox: null,
      correctError: null,
      focusedEdit: null,
    });
  return states.get(id);
}

/** The place in a thread of the person’s last comment, the one a correction replaces; -1 when there’s none. @param {any} t */
export const lastMine = (t) => t.comments.findLastIndex((/** @type {any} */ c) => c.author === PERSON);

/** Where a thread is, as its correction’s box and button name it. @param {any} t @param {any} b */
const placeIn = (t, b) => placeOf(placeKey(t, b), b);

/** Edit, on the person’s sent comment: its box opens with what they sent, in place of another correction’s. */
export function correctButton(t, { b, itemId, rerender }) {
  const open = () => {
    const d = correctionOf(itemId);
    d.correcting = t.id;
    d.correctingText = t.comments[lastMine(t)].text;
    d.correctingSelection = null;
    d.correctFocus = true;
    d.correctError = null;
    rerender();
  };
  const label = `Edit your sent comment on ${placeIn(t, b)}`;
  const d = correctionOf(itemId);
  // Which Edit last had focus: focus moving to another control forgets it; the button leaving the page doesn’t.
  const track = {
    onfocus: () => {
      d.focusedEdit = t.id;
    },
    onblur: (/** @type {FocusEvent} */ e) => {
      if (e.relatedTarget) d.focusedEdit = null;
    },
  };
  const button = h(
    'button.btn.sm.ghost',
    { type: 'button', style: { marginLeft: 'auto' }, 'aria-label': label, 'data-correct': t.id, onclick: open, ...track },
    'Edit',
  );
  // Over a repaint, focus stays here while this Edit had it last and nothing else has it since. After a correction
  // is sent, focus goes to the message box, as after any act on a block (thread.mjs).
  const active = document.activeElement;
  const had = d.focusedEdit === t.id && (!active || active === document.body || /** @type {HTMLElement} */ (active).dataset?.correct === t.id);
  if (had) queueMicrotask(() => button.isConnected && button.focus());
  return button;
}

/**
 * The box a correction is written in, under its thread. Send correction sends it and closes the box; a refusal opens it
 * again with what was typed and why. Cancel drops it, and focus goes back to Edit.
 * @param {any} t @param {any} env  { b, itemId, rerender, correct }
 */
export function correctionBox(t, { b, itemId, rerender, correct }) {
  const d = correctionOf(itemId);
  const close = () => {
    d.correcting = null;
    /** @type {HTMLElement | null} */ (rerender().querySelector(`[data-correct="${CSS.escape(t.id)}"]`))?.focus();
  };
  // The correction’s own update draws the thread again with it, and without the box. Only a refusal draws it here,
  // from this box, which is still on the page.
  const send = (/** @type {string} */ value) => {
    if (!value.trim()) return;
    d.correcting = null;
    correct(t.id, value).catch((/** @type {any} */ e) => {
      Object.assign(d, { correcting: t.id, correctingText: value, correctFocus: true, correctError: e.message });
      rerender();
    });
  };
  const box = commentBox(d, {
    label: `Edit your sent comment on ${placeIn(t, b)}`,
    mark: 'data-correcting',
    opened: 'correctFocus',
    fields: ['correctingText', 'correctingSelection'],
    text: typeof d.correctingText === 'string' ? d.correctingText : t.comments[lastMine(t)].text,
    quote: null,
    saveLabel: 'Send correction',
    hint: 'What you sent stays, with this after it.',
    onSave: send,
    onCancel: close,
  });
  return [box, d.correctError ? h('p.err', { role: 'alert' }, icon('warn'), d.correctError) : null];
}
