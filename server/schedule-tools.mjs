// schedule_wake and cancel_wake (#458), the tools. schedule_wake asks to be woken later; moved from server/runtime.mjs,
// whose toolsFor calls it, to keep runtime.mjs under its ceiling. cancel_wake: an agent cancels a wake it scheduled with
// schedule_wake, which gave it the wake's id, once it has finished the work the wake was for. It reaches only that
// session's own pending wakes, and cancels as the person's Cancel does (Runtime.cancelSchedule): the schedule line reads
// canceled, and no turn starts.

import { echoedId } from './helpers.mjs';

/** cancel_wake { id }, the tool, for the session rt.toolsFor made it for. @param {any} rt @param {string} sessionId @param {{ id?: unknown }} args */
export function cancelWake(rt, sessionId, { id } = {}) {
  const sc = typeof id === 'string' ? rt.s.schedules[id] : null;
  // Another agent's wake reads as one that doesn't exist, so an id says nothing about anyone else's schedule.
  if (!sc || sc.sessionId !== sessionId)
    return { ok: false, message: `You have no pending wake with the id “${echoedId(id)}”: it fired already, was canceled, or isn’t yours.` };
  rt.cancelSchedule(sc.id);
  return { ok: true, message: `Canceled your wake for ${new Date(sc.at).toISOString()}.` };
}

/** schedule_wake { in_minutes, note }, the tool, for the session rt.toolsFor made it for. @param {any} rt @param {string} sessionId @param {{ in_minutes?: any, note?: any }} args */
export function scheduleWakeTool(rt, sessionId, { in_minutes, note }) {
  const sc = rt.schedule(sessionId, { inMs: Math.round((+in_minutes || 1) * 60000), note });
  return { ok: true, message: `You’ll be woken at ${new Date(sc.at).toISOString()}. Its id is ${sc.id}, for cancel_wake.` };
}
