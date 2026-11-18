// What an app sent its agent without the person’s click (#1488): notes, kept in the private state key `appNotes` until
// the agent reads them with read_app (server/app-notes.mjs). The reducer keeps the newest APP_NOTES_MAX of an app’s
// notes and counts the ones it dropped, so the log holds one note per event, never the whole list again.

/** The notes an app keeps for its agent; older ones are dropped and counted, so the agent knows some are missing. */
export const APP_NOTES_MAX = 50;

/** `app.note`: one note added to its app’s record. @param {any} s @param {{ id: string, note: any }} d */
export function addNote(s, d) {
  const rec = s.appNotes[d.id] ?? { id: d.id, notes: [], dropped: 0 };
  const notes = [...rec.notes, d.note];
  const over = Math.max(0, notes.length - APP_NOTES_MAX);
  s.appNotes[d.id] = { id: d.id, notes: notes.slice(over), dropped: rec.dropped + over };
}

/** `app.notes.read`: the agent read its app’s notes, so they’re gone. @param {any} s @param {{ id: string }} d */
export function takeNotes(s, d) {
  delete s.appNotes[d.id];
}
