// A conversation’s model and effort (/model, /effort). A Runtime method’s body, with the instance first, as in
// server/apps.mjs.

import { httpError } from './helpers.mjs';
import { checkEffort } from './persona-checks.mjs';

/**
 * Changes the model or the effort a conversation runs with (/model, /effort). Both are fixed in the session’s
 * snapshot, so this changes the snapshot: from the next turn, and now too where the backend can change a running
 * turn (the Agent SDK’s setModel and its effort setting, tried and reported).
 * @param {any} rt @param {string} sessionId @param {{ model?: string, effort?: string }} change
 * @returns {Promise<{ ok: true, now: boolean }>}
 */
export async function setSessionRun(rt, sessionId, { model, effort }) {
  const se = rt.session(sessionId);
  if (rt.persona(se.personaId)?.backend === 'mock') throw httpError(409, 'A mock agent has no model or effort to change.');
  /** @type {Record<string, string>} */
  const patch = {};
  if (model !== undefined) {
    const m = String(model).trim();
    if (!m || m.length > 100 || !/^[\w.:[\]-]+$/.test(m)) throw httpError(422, 'A model is a name such as claude-opus-5-5.');
    patch.model = m;
  }
  if (effort !== undefined) {
    checkEffort(effort);
    patch.effort = String(effort);
  }
  if (!Object.keys(patch).length) throw httpError(422, 'Say which model or effort to use.');
  rt.updateSession(se.id, { personaSnapshot: { ...(se.personaSnapshot ?? {}), ...patch } });
  const control = rt.turns.get(se.id)?.control;
  let now = false;
  if (control) {
    const results = await Promise.all([
      patch.model && control.setModel ? control.setModel(patch.model) : null,
      patch.effort && control.setEffort ? control.setEffort(patch.effort) : null,
    ]);
    now = results.filter((r) => r !== null).length > 0 && results.every((r) => r !== false);
  }
  return { ok: true, now };
}
