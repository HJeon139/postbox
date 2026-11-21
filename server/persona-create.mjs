// POST /api/personas (server/index.mjs): a new agent, joined to a conversation or starting one with it, and kept as a
// boilerplate when the person asks. Moved out of server/index.mjs.

import { toBoilerplate } from './seed.mjs';

/**
 * Makes the agent, then joins it where the page asked.
 * @param {any} rt @param {import('./store.mjs').Store} store @param {any} body  the route's body
 */
export function createPersonaFor(rt, store, body) {
  const p = rt.createPersona(body);
  if (body.join?.threadId) rt.ensureSession(rt.threads.lineage(body.join.threadId).at(-1), p.id, { brief: 'You were just created and added to this thread.' });
  else if (body.join?.projectId) rt.createThread({ projectId: body.join.projectId, title: body.join.title || `With @${p.handle}`, personaIds: [p.id] });
  if (body.saveAsBoilerplate) store.emit('boilerplate', toBoilerplate(p));
  return p;
}
