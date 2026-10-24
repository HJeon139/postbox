// What the composer (app/js/thread.mjs, mountComposer) says when the agent it acts for works on a remote host (#120):
// that Stop takes the turn’s background jobs there with it, said before you press it, and that `!` runs on this
// computer, not on the host.

import { h } from './dom.mjs';
import { hostOf, stopNote } from './remote.mjs';

/**
 * On a host, Stop takes the turn’s background jobs with it: what it says before you press it, tied to the button.
 * @param {HTMLElement} action  the composer’s Send or Stop @param {any} b  the agent at work, if any @param {string} threadId
 */
export function describeStop(action, b, threadId) {
  const note = b ? stopNote(b) : null;
  if (note) action.setAttribute('aria-describedby', `stop-note-${threadId}`);
  else action.removeAttribute('aria-describedby');
  return note;
}
/** The note itself, above the composer. @param {string | null} note @param {string} threadId */
export const stopNoteEl = (note, threadId) =>
  note ? h('div.sys.stop-note', { style: { marginBottom: '6px' } }, h('span.small.dim', { id: `stop-note-${threadId}` }, note)) : '';

/** `!` stays on this computer when the agent works on a host, and its hint says so. Null otherwise. @param {any} se */
export function notOnHost(se) {
  const away = hostOf(se);
  return away ? [' on this computer, not on ', h('b', away.name), ','] : null;
}
