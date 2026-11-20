// A run clock’s events as a trajectory’s system steps (tools/atif.mjs, server/run-clock.mjs). Moved from
// tools/atif.mjs, which keeps its length limit.
//
// A turn the clock’s pause or expiry stopped may run on: on a host until the host confirms the stop
// (server/remote/turns-stops.mjs), on this computer until its CLI has exited, after up to its grace period
// (server/turn-stop.mjs). Postbox records nothing of what it did meanwhile. So each such stop is listed, with when
// Postbox stopped it and when it ended, if it did in the recording, and the trajectory says it’s partial
// (hydrant-critic’s review of #1522).

import { isLocalStop } from '../shared/run-clock.mjs';

/** Whether a clock event’s stops wait on a host. @param {any} d */
const onHost = (d) => Boolean(d.stopping?.some((/** @type {string} */ t) => !isLocalStop(t)));

/** Each clock event’s words, from its data. @type {Record<string, (d: any) => string>} */
export const CLOCK_WORDS = {
  'clock.started': (d) => `Run clock started with a budget of ${d.budgetMs / 1000}s.`,
  'clock.paused': (d) => {
    if (onHost(d)) return 'Run clock paused: Postbox asked the agent’s host to stop it, and the clock counts on until the host confirms.';
    return `Run clock paused: Postbox stopped the agent until it resumes${d.stopping?.length ? ', and the clock counts on until its turn has ended' : ''}.`;
  },
  'clock.resumed': () => 'Run clock resumed.',
  'clock.turn': (d) => `Turn started at elapsed ${Math.floor(d.elapsedMs / 1000)}s of ${d.budgetMs / 1000}s.`,
  'clock.restored': (d) =>
    `Postbox started again with the run clock at elapsed ${Math.floor(d.elapsedMs / 1000)}s of ${d.budgetMs / 1000}s; the time it was down counted.`,
  'clock.expired': (d) => {
    if (onHost(d))
      return `Run clock expired at its budget of ${d.budgetMs / 1000}s: Postbox asked the agent’s host to stop it, which the host hadn’t confirmed yet.`;
    const exiting = d.stopping?.length ? 'stopped the agent’s turn, which may run on until its CLI has exited' : 'stopped the agent';
    return `Run clock expired at its budget of ${d.budgetMs / 1000}s: Postbox ${exiting}.`;
  },
  'clock.stopped': (d) => {
    if (!isLocalStop(d.turn)) return 'The agent’s host confirmed its turn stopped.';
    return d.forced
      ? `Postbox couldn’t confirm the agent’s stopped turn ended (${d.why}), so it may still have been working: the timed run is void.`
      : 'The agent’s stopped turn ended.';
  },
};

/**
 * The stops a session’s clock events made, each with when it ended if the recording has it: one per turn.
 * @param {{ type: string, data: any }[]} clocks  the session’s clock events, in order
 */
export function clockStops(clocks) {
  /** @type {Map<string, { turn: string, where: 'host' | 'local', asked_by: string, asked_at: number, confirmed_at: number | null, forced?: string }>} */
  const stops = new Map();
  for (const c of clocks) {
    // An expiry lists a turn a pause already stopped, which it didn’t stop again: the first is the stop.
    if (c.type === 'clock.paused' || c.type === 'clock.expired')
      for (const turn of c.data.stopping ?? [])
        if (!stops.has(turn)) stops.set(turn, { turn, where: isLocalStop(turn) ? 'local' : 'host', asked_by: c.type, asked_at: c.data.at, confirmed_at: null });
    const open = c.type === 'clock.stopped' ? stops.get(c.data.turn) : undefined;
    if (open && open.confirmed_at === null) Object.assign(open, { confirmed_at: c.data.at }, c.data.forced ? { forced: c.data.why } : {});
  }
  return [...stops.values()];
}

/** What a trajectory says of one stop. @param {ReturnType<typeof clockStops>[number]} s @param {(ms: number) => string} iso */
function stopSaid(s, iso) {
  const from = `from ${iso(s.asked_at)} (${s.asked_by})`;
  const host = s.where === 'host';
  if (s.confirmed_at === null)
    return `${from} ${host ? 'its host never confirmed the stop' : 'its turn never ended'} in this recording, so the agent may have gone on working${host ? ' there' : ''}`;
  const later = `${((s.confirmed_at - s.asked_at) / 1000).toFixed(3)}s later`;
  if (host) return `${from} until its host confirmed the stop ${later}, the agent may have gone on working there`;
  if (s.forced)
    return `${from} until Postbox stopped waiting for its turn to end (${s.forced}) ${later}, the agent may have gone on working, and may have after it too`;
  return `${from} until its turn ended ${later}, the agent may have gone on working`;
}

/** How many times, as words. @param {number} n */
const timesOf = (n) => (n === 1 ? 'once' : `${n} times`);

/** What a trajectory’s note says of its stops in all, by where they ran. @param {ReturnType<typeof clockStops>} stops */
function lead(stops) {
  const host = stops.filter((s) => s.where === 'host').length;
  const local = stops.length - host;
  if (!local) return `Postbox asked the agent’s host to stop its turn ${timesOf(host)}, and records nothing the turn did until the host confirmed`;
  if (!host) return `Postbox stopped the agent’s turn ${timesOf(local)}, and records nothing it did until the turn ended`;
  return `Postbox stopped the agent’s turn ${timesOf(stops.length)} (${timesOf(local)} on this computer, ${timesOf(host)} on its host), and records nothing a turn did until it ended or its host confirmed`;
}

/**
 * The note and extra a trajectory gets for its clock’s stops: none when it has none.
 * @param {ReturnType<typeof clockStops>} stops @returns {{ note: string|null, extra: Record<string, any> }}
 */
export function stopsScope(stops) {
  if (!stops.length) return { note: null, extra: {} };
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
  const forced = stops.find((s) => s.forced && s.confirmed_at !== null);
  const voided = forced
    ? `Void as a timed run: Postbox couldn’t confirm one of the agent’s stopped turns ended (${forced.forced}), so the agent may have worked uncounted, and Postbox ended the run. `
    : '';
  return {
    note: `${voided}Partial: ${lead(stops)}: ${stops.map((s) => stopSaid(s, iso)).join('; ')}.`,
    extra: {
      stops: stops.map((s) => ({ ...s, asked_at: iso(s.asked_at), confirmed_at: s.confirmed_at === null ? null : iso(s.confirmed_at) })),
      ...(forced ? { clock_void: { why: forced.forced, at: iso(/** @type {number} */ (forced.confirmed_at)) } } : {}),
    },
  };
}
