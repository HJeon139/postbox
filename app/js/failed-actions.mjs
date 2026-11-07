// A failed reply’s actions (#883): Retry, and Dismiss until the person has dismissed it. The room’s callout
// (thread.mjs) and a side thread’s line (side-line.mjs) both draw them from here, so the choice of buttons is made in
// one place. A dismissed reply keeps its error readable in a quieter row, with no role="alert", so a screen reader
// isn’t told about it again on every redraw.

import { api } from './client.mjs';
import { h, icon } from './dom.mjs';
import { toast } from './ui.mjs';

/**
 * Retry, and Dismiss unless the reply is dismissed. `name` names the turn in each button’s label where the button
 * alone wouldn’t say which, as on a side thread’s line. `focusAfter` is the control, inside the same transcript item,
 * that keeps the keyboard once Dismiss is gone (app/AGENTS.md: focus stays on the control you used): the room’s Retry,
 * or the side line’s Open.
 * @param {string} threadId @param {string} itemId @param {{ dismissed?: boolean, name?: string, focusAfter?: string }} [o]
 */
export function failedActions(threadId, itemId, { dismissed = false, name, focusAfter = '.callout button' } = {}) {
  const at = `/api/threads/${threadId}/items/${itemId}`;
  const retry = h(
    'button.btn.sm',
    {
      type: 'button',
      'aria-label': name ? `Retry ${name}` : null,
      onclick: () => api(`${at}/retry`, {}).catch((e) => toast({ title: 'Retry didn’t start', text: e.message, level: 'blocking' })),
    },
    icon('retry', 'i-sm'),
    'Retry',
  );
  if (dismissed) return [retry];
  const dismiss = h(
    'button.btn.sm.ghost',
    {
      type: 'button',
      'aria-label': name ? `Dismiss ${name}` : null,
      onclick: (/** @type {MouseEvent} */ ev) => {
        const used = /** @type {HTMLElement} */ (ev.currentTarget);
        const holder = used.closest('[data-key]');
        api(`${at}/dismiss`, {})
          .then(() => holder && focusWhenDrawn(/** @type {HTMLElement} */ (holder), used, focusAfter))
          .catch((e) => toast({ title: 'It wasn’t dismissed', text: e.message, level: 'blocking' }));
      },
    },
    'Dismiss',
  );
  return [retry, dismiss];
}

/**
 * The callout under a failed reply in the room: its error and its actions, quieter once dismissed.
 * @param {string} threadId @param {any} it  the failed reply @param {any[]} text  its error, as the room words it
 */
export function failedCallout(threadId, it, text) {
  const actions = failedActions(threadId, it.id, { dismissed: it.dismissed === true });
  if (it.dismissed)
    return h('div.callout.quiet', h('span.g.g-failed', { 'aria-hidden': 'true' }), h('div.grow', ...text, h('span.dim', ' Dismissed.')), ...actions);
  return h('div.callout', { role: 'alert' }, h('span.g.g-failed', { 'aria-hidden': 'true' }), h('div.grow', ...text), ...actions);
}

/**
 * Puts the keyboard on `selector` inside the item that held Dismiss, once the redraw has taken Dismiss away and dropped
 * the focus to the page; the redraw comes with the store's next event, so it looks every 50 ms for up to 2 s. It leaves
 * the focus alone if the person has moved it meanwhile.
 * @param {HTMLElement} holder  the transcript item, `[data-key]`
 * @param {HTMLElement} used  the Dismiss button, focused until the redraw takes it away @param {string} selector
 */
function focusWhenDrawn(holder, used, selector) {
  const key = holder.dataset.key ?? '';
  // The transcript it's in, which outlives the redraw; the item itself is drawn anew.
  const scope = holder.closest('#main, .sidepanel') ?? document;
  const until = Date.now() + 2000;
  const look = () => {
    const now = document.activeElement;
    // Nobody has moved the keyboard yet: it's still on Dismiss, or the redraw dropped it to the page.
    if (now && now !== document.body && now !== used) return;
    const target = /** @type {HTMLElement | null} */ (scope.querySelector(`[data-key="${CSS.escape(key)}"] ${selector}`));
    // Only once the redraw has taken Dismiss away: before that, the control found may be the one about to be replaced.
    if (target && !used.isConnected) target.focus();
    else if (Date.now() < until) setTimeout(look, 50);
  };
  look();
}
