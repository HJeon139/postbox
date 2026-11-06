// The writes of a session that exists: its changed fields as a session.patch (server/session-patch.mjs), and the
// Postbox notices it reads at the start of its next turn.

import { sessionPatch } from './session-patch.mjs';

/** Writes the fields of `patch` that change the session, with updatedAt. A session that doesn’t exist isn’t written. @param {import('./runtime.mjs').Runtime} rt @param {string} id @param {Record<string, unknown>} patch */
export function updateSession(rt, id, patch) {
  const se = rt.s.sessions[id];
  if (!se) return;
  rt.store.emit('session.patch', sessionPatch(se, { ...patch, updatedAt: Date.now() }));
}

/** Context the agent reads at the start of its next turn, as a Postbox notice. @param {import('./runtime.mjs').Runtime} rt @param {string} sessionId @param {string} text */
export function tellAgent(rt, sessionId, text) {
  const se = rt.s.sessions[sessionId];
  if (se) rt.updateSession(sessionId, { context: [...(se.context ?? []), `[Postbox] ${text}`].slice(-20) });
}
