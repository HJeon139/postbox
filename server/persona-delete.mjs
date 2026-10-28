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
  if (!p?.deleting) throw httpError(409, 'It’s too late to undo: that agent is already deleted.');
  clearTimeout(rt.timers.get(`delp:${id}`));
  rt.timers.delete(`delp:${id}`);
  for (const sid of p.deletingSessions ?? []) if (rt.s.sessions[sid]?.deleting) rt.undoDelete(sid);
  const { deleting: _d, deletingSessions: _s, ...kept } = p;
  rt.store.emit('persona', kept);
}

/**
 * The end of the window: its sessions are purged (each one’s own timer may have run first), each backend forgets it,
 * and the persona is removed.
 * @param {any} rt @param {string} id
 */
export async function purgePersona(rt, id) {
  rt.timers.delete(`delp:${id}`);
  const p = rt.s.personas[id];
  if (!p?.deleting) return;
  for (const sid of p.deletingSessions ?? []) rt.purgeSession(sid);
  for (const name of rt.adapters.names()) {
    const adapter = rt.adapters.get(name);
    if (typeof adapter.forget !== 'function') continue;
    // A memory that can’t be removed stays on disk, and the server log says where; the persona goes either way.
    await adapter.forget(p).catch((e) => console.error(`Postbox couldn’t remove @${p.handle}’s memory (${name}): ${e.message}`));
  }
  rt.store.emit('remove', { kind: 'persona', id });
}
