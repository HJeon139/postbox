// Deleting a persona (#208): its sessions go with it, as deleting each would take them, then the persona, and each
// backend forgets what it remembered (an adapter’s forget, such as the Claude adapters’ memory folders). It happens at
// once: there is no Undo window. A new persona with the same name starts clean,
// since memory is kept by id.

import { httpError } from './helpers.mjs';

/**
 * Deletes a persona, its sessions and its memory.
 * @param {any} rt @param {string} id
 * @returns {{ handle: string, forgotten: Promise<void> }}  forgotten settles once every backend has forgotten it
 */
export function deletePersona(rt, id) {
  // Pending, the agent and its sessions: either may have been made behind a held commit.
  const p = rt.store.pending.persona(id);
  if (!p) throw httpError(404, 'That agent doesn’t exist.');
  for (const { id: sid } of Object.values(rt.store.pending.sessions()).filter((se) => se.personaId === id)) {
    // Read again each time: deleting one can erase others, as its conversation goes with it, side threads too.
    if (rt.store.pending.session(sid)) rt.deleteSession(sid);
  }
  rt.store.emit('remove', { kind: 'persona', id });
  return { handle: p.handle, forgotten: forget(rt, p) };
}

/**
 * Each backend forgets the persona. A memory that can’t be removed stays on disk, and the server log says where; the
 * persona is gone either way. @param {any} rt @param {any} p
 */
async function forget(rt, p) {
  for (const name of rt.adapters.names()) {
    const adapter = rt.adapters.get(name);
    if (typeof adapter.forget !== 'function') continue;
    await adapter.forget(p).catch((/** @type {any} */ e) => console.error(`Postbox couldn’t remove @${p.handle}’s memory (${name}): ${e.message}`));
  }
}
