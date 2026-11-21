// What the person sees of an app’s pre-display check: the placeholder while its agent fixes what the check found, and
// the note on an app shown with problems (designs/agent-apps.md, “The pre-display check”). What the check found is
// written for the agent, with pixel sizes and CSS advice, and reaches it as an `app-check` message or a lint turn; the
// person sees a plain status (#948, #981).

import { h, icon } from './dom.mjs';

/** Problems of Postbox’s own check, which no agent can fix: the frame never answered, or a check threw. */
const OWN = new Set(['no-answer', 'check-error']);

/**
 * The placeholder while the app’s agent fixes what the check found in its first version.
 * @param {(lines: any[], height?: number) => HTMLElement} placeholder  mountApp’s placeholder
 * @param {string} owner  the agent’s handle
 */
export function fixingPlaceholder(placeholder, owner) {
  return placeholder(
    [
      h(
        'span.row-flex',
        h('span.g.g-running', { 'aria-hidden': 'true' }),
        h('b', { style: { color: 'var(--text)', fontWeight: 500 } }, `${owner} is fixing this app before you see it`),
      ),
      h('span', 'Postbox’s check found something to fix. The fixed version appears here.'),
    ],
    200,
  );
}

/**
 * The note above the version shown, read-only, while the agent fixes a later one.
 * @param {any} app
 * @param {string} owner  the agent’s handle
 * @param {number} shown  the version shown
 */
export const fixingNote = (app, owner, shown) =>
  h('div.app-note', icon('clock'), h('span', `${owner} is fixing v${app.current}. Until then, this is v${shown}, read-only.`));

/**
 * What the note above an app the check passed with problems says, in plain words.
 * @param {any} check  the app’s check: its problems, and whether they were warnings only and the agent was told
 * @param {string} owner  the agent’s handle
 */
export function checkNoteText(check, owner) {
  const problems = check.problems ?? [];
  if (problems.length && problems.every((p) => OWN.has(p.code))) return 'Postbox couldn’t finish checking this app, so it’s shown as it is.';
  // Warnings only follow a first version; anything else that’s left followed a fix that didn’t take.
  const lead = check.notes ? '' : `Shown with problems ${owner} couldn’t fix. `;
  const what = problems.some((p) => p.code === 'only-error')
    ? 'It may be showing an error in place of what it’s for.'
    : `${check.notes ? 'Some text or marks here' : 'Parts of it'} may be hard to read or use.`;
  return `${lead}${what}${check.told ? ` ${owner} has the details.` : ''}`;
}

/**
 * The note above an app the check passed with problems.
 * @param {any} app
 * @param {string} owner  the agent’s handle
 */
export const checkNote = (app, owner) => h('div.app-note', icon('warn'), h('span', checkNoteText(app.check, owner)));
