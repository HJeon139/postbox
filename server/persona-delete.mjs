// Deleting a persona (#208, decided 27 October 2026): its sessions go with it, as deleting each would take them, and
// once the Undo window has passed, so does what it remembered: each backend forgets it (an adapter’s forget, such as
// the Claude adapters’ memory folders). Undo brings back the persona, the sessions this delete took and its memory.
// A new persona with the same name starts clean, since memory is kept by id.

import { httpError } from './helpers.mjs';
import { DELETE_UNDO_MS } from './runtime.mjs';

/**
 * Starts deleting a persona: its sessions now, with their own Undo, and the persona when the window ends.
 * @param {any} rt @param {string} id
 * @returns {{ until: number, handle: string }}
 */
export function deletePersona(rt, id) {
  const p = rt.persona(id);
  if (!p) throw httpError(404, 'That agent doesn’t exist.');
  if (p.deleting) return { until: p.deleting, handle: p.handle };
  // Only those not already being deleted on their own, so Undo here doesn’t bring back one deleted before.
  const took = Object.values(rt.s.sessions).filter((se) => se.personaId === id && !se.deleting);
  for (const se of took) rt.deleteSession(se.id);
  const until = Date.now() + DELETE_UNDO_MS;
  rt.store.emit('persona', { ...p, deleting: until, deletingSessions: took.map((se) => se.id) });
  clearTimeout(rt.timers.get(`delp:${id}`));
  rt.timers.set(`delp:${id}`, setTimeout(() => purgePersona(rt, id), DELETE_UNDO_MS).unref());
  return { until, handle: p.handle };
}

/** Undo: the persona stays, with the sessions its delete took. @param {any} rt @param {string} id */
export function undoDeletePersona(rt, id) {
  const p = rt.persona(id);
  if (!p?.deleting || p.purging) throw httpError(409, 'It’s too late to undo: that agent is already deleted.');
  clearTimeout(rt.timers.get(`delp:${id}`));
  rt.timers.delete(`delp:${id}`);
  const { deleting: _d, deletingSessions: _s, ...kept } = p;
  // The persona first: a session’s Undo is refused while its persona is being deleted (rt.undoDelete).
  rt.store.emit('persona', kept);
  for (const sid of p.deletingSessions ?? []) if (rt.s.sessions[sid]?.deleting) rt.undoDelete(sid);
}

/**
 * The end of the window: it’s marked purging first, so an Undo while a backend forgets it says it’s too late rather
 * than bringing back a persona with its sessions gone. Then every session it has goes, not only those its delete took
 * (one deleted on its own before, or restored meanwhile), so none is left with no persona; each backend forgets it;
 * and the persona is removed. A purge a restart cut short starts again from the top (rearmPersonaDeletes).
 * @param {any} rt @param {string} id
 */
export async function purgePersona(rt, id) {
  rt.timers.delete(`delp:${id}`);
  const p = rt.s.personas[id];
  if (!p?.deleting) return;
  // Not when it’s already purging: a restart can cut a purge short, and each step below is safe to repeat.
  if (!p.purging) rt.store.emit('persona', { ...p, purging: true });
  for (const { id: sid } of Object.values(rt.s.sessions).filter((x) => x.personaId === id)) {
    // Read again each time: purging one can erase others, as its conversation goes with it, side threads too.
    const se = rt.s.sessions[sid];
    if (!se) continue;
    if (!se.deleting) rt.deleteSession(sid);
    rt.purgeSession(sid);
  }
  for (const name of rt.adapters.names()) {
    const adapter = rt.adapters.get(name);
    if (typeof adapter.forget !== 'function') continue;
    // A memory that can’t be removed stays on disk, and the server log says where; the persona goes either way.
    await adapter.forget(p).catch((e) => console.error(`Postbox couldn’t remove @${p.handle}’s memory (${name}): ${e.message}`));
  }
  rt.store.emit('remove', { kind: 'persona', id });
}

/**
 * Deletes still pending when Postbox stopped (engineering-practices.md: re-arm timers from stored state, #24): each
 * finishes when its window ends, or now if it’s over. index.mjs calls this beside rt.rearmDeletions().
 * @param {any} rt
 */
export function rearmPersonaDeletes(rt) {
  for (const p of Object.values(rt.s.personas))
    if (p.deleting) rt.timers.set(`delp:${p.id}`, setTimeout(() => purgePersona(rt, p.id), Math.max(0, p.deleting - Date.now())).unref());
}
