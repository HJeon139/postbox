// What an app sends its agent without the person’s click (#1488): a note. The browser sends one for a send it saw no
// click or key press for (on load, on a timer, after a long await, from a frame that took the keyboard), and for a
// second send of the same click (app/js/app-send.mjs), so one click starts at most one turn. A note starts no turn,
// writes no line in the person’s voice and waits on no card: it’s kept for the app’s agent, which hears at its next turn
// that the app sent notes, one notice for a burst, and reads them with read_app, which takes them.
// The record is private (shared/state.mjs, PRIVATE_STATE_KEYS), as what an app published is: no page reads it.

import { buildEvent } from '../shared/events.mjs';
import { noticeOnce } from './app-notice.mjs';
import { httpError, refuseRetired } from './helpers.mjs';

/**
 * A send of the app’s that isn’t a click’s turn, kept for its agent. It’s checked as an event is, so a note carries what
 * an event could, and nothing more. @param {any} rt @param {string} appId @param {unknown} action @param {unknown} values
 */
export function noteApp(rt, appId, action, values) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  if (app.retired) throw httpError(409, `${app.title} was retired, so it can’t send messages.`);
  // Unchecked until buildEvent checks it, as appEvent’s action and values are.
  const r = buildEvent({ type: 'app', id: appId, title: app.title }, /** @type {string} */ (action), /** @type {any} */ (values ?? {}));
  if (!r.ok) throw httpError(422, r.error);
  refuseRetired(rt.s.sessions[app.sessionId]);
  const note = { action: r.event.action, values: r.event.values, ...(r.quote ? { summary: r.quote } : {}), at: Date.now() };
  rt.store.emit('app.note', { id: appId, note });
  noticeOnce(rt, app, 'has sent notes on its own');
  return { ok: true, noted: true };
}

/**
 * The notes waiting for the app’s own agent, as read_app shows them: none for another agent, which can read what the
 * app published but not take its agent’s notes. @param {any} rt @param {any} app @param {string} sessionId
 * @returns {{ notes?: any[], droppedNotes?: number }}
 */
export function notesFor(rt, app, sessionId) {
  const rec = app.sessionId === sessionId ? rt.s.appNotes[app.id] : null;
  if (!rec) return {};
  return { notes: rec.notes, ...(rec.dropped ? { droppedNotes: rec.dropped } : {}) };
}

/** The agent read its app’s notes to the end, so they’re gone. @param {any} rt @param {string} appId */
export function takeNotes(rt, appId) {
  if (rt.s.appNotes[appId]) rt.store.emit('app.notes.read', { id: appId });
}
