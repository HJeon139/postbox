// cancel_wake (#458): an agent cancels a wake it scheduled with schedule_wake, which gave it the wake's id, once it has
// finished the work the wake was for. It reaches only that session's own pending wakes, and cancels as the person's
// Cancel does (Runtime.cancelSchedule): the schedule line reads canceled, and no turn starts.

/** cancel_wake { id }, the tool, for the session rt.toolsFor made it for. @param {any} rt @param {string} sessionId @param {{ id?: unknown }} args */
export function cancelWake(rt, sessionId, { id } = {}) {
  const sc = typeof id === 'string' ? rt.s.schedules[id] : null;
  // Another agent's wake reads as one that doesn't exist, so an id says nothing about anyone else's schedule.
  if (!sc || sc.sessionId !== sessionId)
    return { ok: false, message: `You have no pending wake with the id “${String(id ?? '').slice(0, 40)}”: it fired already, was canceled, or isn’t yours.` };
  rt.cancelSchedule(sc.id);
  return { ok: true, message: `Canceled your wake for ${new Date(sc.at).toISOString()}.` };
}
