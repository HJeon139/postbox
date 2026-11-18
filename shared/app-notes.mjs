// What an app sent its agent that started no turn (#1488): notes, kept in the private state key `appNotes` until the
// agent reads them with read_app (server/app-notes.mjs). An app keeps APP_NOTES_MAX unread; past that the server logs
// only a count of the ones it dropped, with no payload, so a busy app can’t grow the log with notes nobody reads.

/** The unread notes an app keeps for its agent; later ones are dropped and counted, so the agent knows some are missing. */
export const APP_NOTES_MAX = 50;

/** @param {any} s @param {string} id */
const recordOf = (s, id) => s.appNotes[id] ?? { id, notes: [], dropped: 0 };

/** `app.note`: one note added to its app’s record; the server sends none past the cap, and the cut is a backstop. */
export function addNote(s, d) {
  const rec = recordOf(s, d.id);
  const notes = [...rec.notes, d.note];
  const over = Math.max(0, notes.length - APP_NOTES_MAX);
  s.appNotes[d.id] = { id: d.id, notes: notes.slice(over), dropped: rec.dropped + over };
}

/** `app.notes.dropped`: a note past the cap, counted and not kept. @param {any} s @param {{ id: string }} d */
export function dropNote(s, d) {
  const rec = recordOf(s, d.id);
  s.appNotes[d.id] = { ...rec, dropped: rec.dropped + 1 };
}

/**
 * `app.notes.read`: the agent read the first `count` notes and the `dropped` count it was shown, so those are gone; any
 * that came after the read stay. Without a count (none was written so), it read them all.
 * @param {any} s @param {{ id: string, count?: number, dropped?: number }} d
 */
export function takeNotes(s, d) {
  const rec = s.appNotes[d.id];
  if (!rec) return;
  const notes = typeof d.count === 'number' ? rec.notes.slice(d.count) : [];
  const dropped = typeof d.dropped === 'number' ? Math.max(0, rec.dropped - d.dropped) : 0;
  if (notes.length || dropped) s.appNotes[d.id] = { id: d.id, notes, dropped };
  else delete s.appNotes[d.id];
}
