// A run clock’s events as a trajectory’s system steps (tools/atif.mjs, server/run-clock.mjs). Moved from
// tools/atif.mjs, which keeps its length limit.
//
// A turn on a host that the clock’s pause or expiry asked to stop may run on until the host confirms the stop
// (server/remote/turns-stops.mjs), and Postbox records nothing of what it did meanwhile. So each such stop is listed,
// with when Postbox asked and when the host confirmed, if it did in the recording, and the trajectory says it’s
// partial (hydrant-critic’s review of #1522).

/** Each clock event’s words, from its data. @type {Record<string, (d: any) => string>} */
export const CLOCK_WORDS = {
  'clock.started': (d) => `Run clock started with a budget of ${d.budgetMs / 1000}s.`,
  'clock.paused': (d) =>
    d.stopping?.length
      ? 'Run clock paused: Postbox asked the agent’s host to stop it, and the clock counts on until the host confirms.'
      : 'Run clock paused: Postbox stopped the agent until it resumes.',
  'clock.resumed': () => 'Run clock resumed.',
  'clock.turn': (d) => `Turn started at elapsed ${Math.floor(d.elapsedMs / 1000)}s of ${d.budgetMs / 1000}s.`,
  'clock.restored': (d) =>
    `Postbox started again with the run clock at elapsed ${Math.floor(d.elapsedMs / 1000)}s of ${d.budgetMs / 1000}s; the time it was down counted.`,
  'clock.expired': (d) =>
    `Run clock expired at its budget of ${d.budgetMs / 1000}s: Postbox ${d.stopping?.length ? 'asked the agent’s host to stop it, which the host hadn’t confirmed yet' : 'stopped the agent'}.`,
  'clock.stopped': () => 'The agent’s host confirmed its turn stopped.',
};

/**
 * The host stops a session’s clock events asked for, each with its confirmation if the recording has it.
 * @param {{ type: string, data: any }[]} clocks  the session’s clock events, in order
 */
export function remoteStops(clocks) {
  const stops = [];
  for (const c of clocks) {
    if (c.type === 'clock.paused' || c.type === 'clock.expired')
      for (const turn of c.data.stopping ?? []) stops.push({ turn, asked_by: c.type, asked_at: c.data.at, confirmed_at: null });
    if (c.type === 'clock.stopped') {
      const open = stops.find((s) => s.turn === c.data.turn && s.confirmed_at === null);
      if (open) open.confirmed_at = c.data.at;
    }
  }
  return stops;
}

/**
 * The note and extra a trajectory gets for its clock’s host stops: none when it has none.
 * @param {ReturnType<typeof remoteStops>} stops @returns {{ note: string|null, extra: Record<string, any> }}
 */
export function stopsScope(stops) {
  if (!stops.length) return { note: null, extra: {} };
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
  const said = stops.map((s) =>
    s.confirmed_at === null
      ? `at ${iso(s.asked_at)} (${s.asked_by}) its host never confirmed the stop in this recording, so the agent may have gone on working there`
      : `from ${iso(s.asked_at)} (${s.asked_by}) until its host confirmed the stop ${((s.confirmed_at - s.asked_at) / 1000).toFixed(3)}s later, the agent may have gone on working there`,
  );
  return {
    note: `Partial: Postbox asked the agent’s host to stop its turn ${stops.length === 1 ? 'once' : `${stops.length} times`}, and records nothing the turn did until the host confirmed: ${said.join('; ')}.`,
    extra: {
      remote_stops: stops.map((s) => ({ ...s, asked_at: iso(s.asked_at), confirmed_at: s.confirmed_at === null ? null : iso(s.confirmed_at) })),
    },
  };
}
