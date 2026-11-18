// What an app sends its agent that starts no turn (#1488): a note. The browser sends one for a send it saw no click or
// key press for (on load, on a timer, from a frame that took the keyboard, or in a browser that can’t tell), and for a
// click’s later sends (app/js/app-send.mjs), so one click starts one turn. A note writes no line in the person’s voice
// and waits on no card: it’s kept for the app’s agent, which hears at its next turn that the app has notes, one notice
// for a burst, and reads them with read_app, which takes the ones it showed.
// The record is private (shared/state.mjs, PRIVATE_STATE_KEYS), as what an app published is: no page reads it. Each
// note is in the log, so a note is small (NOTE_BYTES), the browser sends at most the latest one each 400 ms, and past
// APP_NOTES_MAX unread the log gets only a count.

import { APP_NOTES_MAX } from '../shared/app-notes.mjs';
import { buildEvent } from '../shared/events.mjs';
import { noticeOnce } from './app-notice.mjs';
import { httpError, refuseRetired } from './helpers.mjs';

/** The most one note carries, in bytes of JSON: a quarter of an event’s, since a note is kept unread in the log. */
export const NOTE_BYTES = 16 * 1024;
/**
 * Events an app may start in a minute before the next is a note instead (#1488). The browser starts one per click, so
 * only an app that forges clicks reaches it: generous, so a person clicking fast never does.
 */
export const EVENTS_PER_MINUTE = 30;
const MINUTE = 60_000;

const WHAT = 'has notes for you from sends that started no turn (no click, or a click’s later sends)';

/**
 * A send of the app’s that starts no turn, kept for its agent. It’s checked as an event is, and refused past
 * NOTE_BYTES. `replaced` is how many earlier notes the browser gathered into this one, the latest.
 * @param {any} rt @param {string} appId @param {unknown} action @param {unknown} values @param {unknown} [replaced]
 */
export function noteApp(rt, appId, action, values, replaced = 0) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  if (app.retired) throw httpError(409, `${app.title} was retired, so it can’t send messages.`);
  // Unchecked until buildEvent checks it, as appEvent’s action and values are.
  const r = buildEvent({ type: 'app', id: appId, title: app.title }, /** @type {string} */ (action), /** @type {any} */ (values ?? {}));
  if (!r.ok) throw httpError(422, r.error);
  refuseRetired(rt.s.sessions[app.sessionId]);
  if (Buffer.byteLength(JSON.stringify(r.event.values)) > NOTE_BYTES)
    throw httpError(413, 'A send that starts no turn is a note, of up to 16 KB of JSON. Send ids, or share the data with postbox.publish.');
  if ((rt.s.appNotes[appId]?.notes.length ?? 0) >= APP_NOTES_MAX) rt.store.emit('app.notes.dropped', { id: appId });
  else {
    const gathered = Number.isInteger(replaced) && /** @type {number} */ (replaced) > 0 ? { replaced: Math.min(/** @type {number} */ (replaced), 1e6) } : {};
    const note = { action: r.event.action, values: r.event.values, ...(r.quote ? { summary: r.quote } : {}), ...gathered, at: Date.now() };
    rt.store.emit('app.note', { id: appId, note });
  }
  noticeOnce(rt, app, WHAT);
  return { ok: true, noted: true };
}

/**
 * The page’s event for a click: it starts a turn, unless the app has started EVENTS_PER_MINUTE in the last minute,
 * when it’s a note instead, never a card or an error. Counts the app’s lines in the person’s voice from the newest back.
 * @param {any} rt @param {string} appId @param {unknown} action @param {unknown} values
 */
export function clickEvent(rt, appId, action, values, now = Date.now()) {
  const app = rt.s.apps[appId];
  const items = app ? rt.store.items(app.threadId) : [];
  let recent = 0;
  for (let i = items.length - 1; i >= 0 && recent < EVENTS_PER_MINUTE; i--) {
    const it = items[i];
    if (now - (it.sentAt ?? it.at ?? 0) >= MINUTE) break;
    if (it.kind === 'voice' && it.appId === appId) recent++;
  }
  if (recent >= EVENTS_PER_MINUTE) return noteApp(rt, appId, action, values);
  return rt.appEvent(appId, /** @type {string} */ (action), /** @type {any} */ (values ?? {}), { now });
}

/**
 * The notes waiting for the app’s own agent, as read_app shows them: none for another agent, which can read what the
 * app published but not take its agent’s notes. `upTo` is how many the read’s first part had, for its later parts.
 * @param {any} rt @param {any} app @param {string} sessionId @param {unknown} [upTo]
 * @returns {{ notes?: any[], droppedNotes?: number }}
 */
export function notesFor(rt, app, sessionId, upTo) {
  const rec = app.sessionId === sessionId ? rt.s.appNotes[app.id] : null;
  if (!rec) return {};
  const notes = Number.isInteger(upTo) && /** @type {number} */ (upTo) >= 0 ? rec.notes.slice(0, upTo) : rec.notes;
  return { notes, ...(rec.dropped ? { droppedNotes: rec.dropped } : {}) };
}

/**
 * The agent read its app’s notes to the end: the ones it was shown are gone, and any that came since stay.
 * @param {any} rt @param {string} appId @param {{ notes?: any[], droppedNotes?: number }} shown
 */
export function takeNotes(rt, appId, shown) {
  if (rt.s.appNotes[appId]) rt.store.emit('app.notes.read', { id: appId, count: shown.notes?.length ?? 0, dropped: shown.droppedNotes ?? 0 });
}
