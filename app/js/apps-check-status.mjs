// What the person sees of an app’s pre-display check: the placeholder while its agent fixes what the check found, and
// the note on an app shown with problems (designs/agent-apps.md, “The pre-display check”).

import { h, icon } from './dom.mjs';

/**
 * The placeholder while the app’s agent fixes what the check found.
 * @param {(lines: any[], height?: number) => HTMLElement} placeholder  mountApp’s placeholder
 * @param {any} app
 * @param {string} owner  the agent’s handle
 */
export function fixingPlaceholder(placeholder, app, owner) {
  return placeholder(
    [
      h(
        'span.row-flex',
        h('span.g.g-running', { 'aria-hidden': 'true' }),
        h('b', { style: { color: 'var(--text)', fontWeight: 500 } }, `${owner} is fixing a problem the check found`),
      ),
      h('span', app.check.problems.map((p) => p.message).join(' ')),
      h('span', 'The fixed version appears here.'),
    ],
    200,
  );
}

/**
 * The note above an app the check passed with problems.
 * @param {any} app
 * @param {string} owner  the agent’s handle
 */
export function checkNote(app, owner) {
  return h(
    'div.app-note',
    icon('warn'),
    h(
      'span',
      // Warnings only (marks or text too small, say): the app passed and is shown, and @owner was told.
      `${app.check.notes ? `Shown with notes for ${owner}` : `Shown with problems ${owner} couldn’t fix`}: ${app.check.problems.map((p) => p.message).join(' ')}`,
    ),
  );
}
