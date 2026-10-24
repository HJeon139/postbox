// How a review block is shown (#179): Preview or Lines, and full screen. A Markdown draft opens in Preview, since
// reading comes before commenting, or in Lines when a revision’s changes are there to read. The person’s choice is
// kept for that revision of the block, across reloads. Full screen is the review’s own box, fixed over the window, as
// an app’s is (apps.mjs): Escape or the same button, now “Exit full screen”, closes it, and Tab stays inside.

import { h, icon } from './dom.mjs';

const KEY = (id) => `pb.review-view.${id}`;
const FOCUSABLE = 'button, [href], input, select, textarea, summary, iframe, [tabindex]:not([tabindex="-1"])';

/**
 * Preview or Lines. d keeps it while the page is open; the person’s choice is stored for the revision they made it on.
 * @param {any} item @param {any} b @param {any} d @param {boolean} hasDiff @returns {'preview' | 'lines'}
 */
export function viewOf(item, b, d, hasDiff) {
  if (b.format !== 'markdown') return 'lines';
  const revision = b.revision ?? 1;
  if (d.mode && d.modeRev === revision) return d.mode;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY(item.id)) ?? 'null');
  } catch {
    // Storage that’s off or unreadable leaves the default.
  }
  const chosen = saved?.revision === revision && (saved.mode === 'preview' || saved.mode === 'lines') ? saved.mode : null;
  d.mode = chosen ?? (hasDiff ? 'lines' : 'preview');
  d.modeRev = revision;
  return d.mode;
}

/** The person picks Preview or Lines. @param {any} item @param {any} b @param {any} d @param {'preview' | 'lines'} mode */
export function setView(item, b, d, mode) {
  d.mode = mode;
  d.modeRev = b.revision ?? 1;
  try {
    localStorage.setItem(KEY(item.id), JSON.stringify({ mode, revision: d.modeRev }));
  } catch {
    // Without storage, the choice holds until a reload.
  }
}

/**
 * Two or more choices, one pressed. After a choice the block is drawn again, and focus stays on it.
 * @param {string} label @param {[string, string][]} options  value and label @param {string} value
 * @param {(v: string) => HTMLElement} choose  draws the block again
 */
export function seg(label, options, value, choose) {
  return h(
    'span.seg',
    { role: 'radiogroup', 'aria-label': label },
    options.map(([v, text]) =>
      h(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': String(v === value),
          onclick: () => /** @type {HTMLElement | null} */ (choose(v).querySelector(`[aria-label="${label}"] [aria-checked="true"]`))?.focus(),
        },
        text,
      ),
    ),
  );
}

/** @type {{ box: HTMLElement, close: () => void } | null} the review open full screen */
let full = null;
/**
 * Which reviews are full screen, by item, and the height each had in the conversation. Not in the block’s draft: one
 * drawn before an answer was sent holds a draft that’s gone once it’s sent.
 * @type {Map<string, number>}
 */
const fullAt = new Map();

/**
 * The full-screen button for a review’s head, and fit, which makes the block drawn full screen if it is.
 * @param {string} id  the block’s item @param {() => HTMLElement} rerender
 */
export function fullScreen(id, rerender) {
  const toggle = (node) => {
    if (fullAt.has(id)) fullAt.delete(id);
    else fullAt.set(id, node.offsetHeight);
    /** @type {HTMLElement | null} */ (rerender().querySelector('.rv-full-btn'))?.focus();
  };
  const btn = h('button.btn.icon.sm.rv-full-btn', { type: 'button', 'aria-label': fullAt.has(id) ? 'Exit full screen' : 'Full screen' }, icon('expand'));
  return {
    btn,
    /** @param {HTMLElement} node  the block @param {HTMLElement} box  what goes full screen @param {string} titleId */
    fit(node, box, titleId) {
      btn.onclick = () => toggle(node);
      if (!fullAt.has(id)) return;
      // The block keeps its height in the conversation, so nothing below it jumps.
      node.style.minHeight = `${fullAt.get(id)}px`;
      box.classList.add('rv-full');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', titleId);
      full = { box, close: () => toggle(node) };
    },
  };
}

// Going elsewhere in Postbox (its address changes) ends full screen, so the review doesn’t come back full screen later.
addEventListener('hashchange', () => {
  if (full?.box.isConnected) full.close();
  fullAt.clear();
  full = null;
});

addEventListener('keydown', (e) => {
  if (!full) return;
  if (!full.box.isConnected || !full.box.classList.contains('rv-full')) {
    full = null;
    return;
  }
  // A menu or sheet over it takes its own keys.
  if (e.defaultPrevented || (e.target instanceof Element && e.target.closest('.menu, .backdrop'))) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    full.close();
  }
  if (e.key !== 'Tab') return;
  const f = [...full.box.querySelectorAll(FOCUSABLE)].filter((x) => x instanceof HTMLElement && !x.hidden && x.offsetParent !== null);
  const first = /** @type {HTMLElement} */ (f[0]);
  const last = /** @type {HTMLElement} */ (f.at(-1));
  if (!first) return;
  // From outside it, Tab comes back in; from a selection inside it, Tab goes on from there, to its Comment button.
  const away = !full.box.contains(document.activeElement) && !full.box.contains(getSelection()?.anchorNode ?? null);
  if (away || document.activeElement === (e.shiftKey ? first : last)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
});
