// A failed reply’s actions (#883): Retry, and Dismiss until the person has dismissed it. The room’s callout
// (thread.mjs) and a side thread’s line (side-line.mjs) both draw them from here, so the choice of buttons is made in
// one place. A dismissed reply keeps its error readable in a quieter row, with no role="alert", so a screen reader
// isn’t told about it again on every redraw.

import { api } from './client.mjs';
import { h, icon } from './dom.mjs';
import { toast } from './ui.mjs';

/**
 * Retry, and Dismiss unless the reply is dismissed. `name` names the turn in each button’s label where the button
 * alone wouldn’t say which, as on a side thread’s line.
 * @param {string} threadId @param {string} itemId @param {{ dismissed?: boolean, name?: string }} [o]
 */
export function failedActions(threadId, itemId, { dismissed = false, name } = {}) {
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
      onclick: () => api(`${at}/dismiss`, {}).catch((e) => toast({ title: 'It wasn’t dismissed', text: e.message, level: 'blocking' })),
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
