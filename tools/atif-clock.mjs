// A run clock’s events in a trajectory (tools/atif.mjs): its `extra`, not steps, since the agent never saw them, only
// the clock’s line in its turn’s prompt (#1529). The events are the run clock’s (`clock.*`, #1526), read from the
// recording as data.
//
// A turn the clock’s pause or expiry stopped may run on: on a host until the host confirms the stop, on this computer
// until its CLI has exited. Postbox records nothing of what it did meanwhile. So each such stop is listed, with when
// Postbox stopped it and when it ended, if it did in the recording, and the trajectory says it’s partial. A timed run is
// void when Postbox couldn’t confirm a stopped turn ended (a forced `clock.stopped`), when Postbox started again with
// the clock running (`clock.restored`), or when the clock’s state says so (`voided`, which a snapshot keeps).

/** Whether a stop is of a turn on this computer, which the clock names `turn:` and its id; else a host’s turn id. */
const isLocalStop = (/** @type {string} */ stop) => stop.startsWith('turn:');

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
 * @typedef {{ turn: string, where: 'host' | 'local', asked_by: string, asked_at: number | null, confirmed_at: number | null,
 *   forced?: true, why?: string, gave_up_at?: number }} ClockStop
 * A stop: who asked it (the clock’s pause or expiry, or `stop` for one the clock didn’t make, such as the person’s Stop,
 * which the record has only once Postbox gave up on it), when it ended (confirmed_at), or, for a forced one, when
 * Postbox stopped waiting for it (gave_up_at), with why: then it never ended as far as Postbox knows.
 */

/**
 * The stops a session’s clock events made, each with when it ended if the recording has it: one per turn.
 * @param {{ type: string, data: any }[]} clocks  the session’s clock events, in order @returns {ClockStop[]}
 */
export function clockStops(clocks) {
  /** @type {Map<string, ClockStop>} */
  const stops = new Map();
  const where = (/** @type {string} */ turn) => (isLocalStop(turn) ? 'local' : 'host');
  for (const c of clocks) {
    // An expiry lists a turn a pause already stopped, which it didn’t stop again: the first is the stop.
    if (c.type === 'clock.paused' || c.type === 'clock.expired')
      for (const turn of c.data.stopping ?? [])
        if (!stops.has(turn)) stops.set(turn, { turn, where: where(turn), asked_by: c.type, asked_at: c.data.at, confirmed_at: null });
    if (c.type !== 'clock.stopped') continue;
    const turn = c.data.turn;
    if (!stops.has(turn) && c.data.forced) stops.set(turn, { turn, where: where(turn), asked_by: 'stop', asked_at: null, confirmed_at: null });
    const open = stops.get(turn);
    if (!open || open.confirmed_at !== null || open.gave_up_at !== undefined) continue;
    if (c.data.forced) Object.assign(open, { forced: true, why: c.data.why, gave_up_at: c.data.at });
    else open.confirmed_at = c.data.at;
  }
  return [...stops.values()];
}

/** What a trajectory says of one stop. @param {ClockStop} s @param {(ms: number) => string} iso */
function stopSaid(s, iso) {
  const from = s.asked_at === null ? 'from a stop the clock didn’t make' : `from ${iso(s.asked_at)} (${s.asked_by})`;
  const since = (/** @type {number} */ end) => (s.asked_at === null ? '' : ` ${((end - s.asked_at) / 1000).toFixed(3)}s later`);
  const host = s.where === 'host';
  if (s.forced && s.gave_up_at !== undefined)
    return `${from} until Postbox stopped waiting for its turn to end (${s.why})${since(s.gave_up_at)}, the agent may have gone on working, and may have after it too`;
  if (s.confirmed_at === null)
    return `${from} ${host ? 'its host never confirmed the stop' : 'its turn never ended'} in this recording, so the agent may have gone on working${host ? ' there' : ''}`;
  if (host) return `${from} until its host confirmed the stop${since(s.confirmed_at)}, the agent may have gone on working there`;
  return `${from} until its turn ended${since(s.confirmed_at)}, the agent may have gone on working`;
}

/** How many times, as words. @param {number} n */
const timesOf = (n) => (n === 1 ? 'once' : `${n} times`);

/** What a trajectory’s note says of its stops in all, by where they ran. @param {ClockStop[]} stops */
function lead(stops) {
  const host = stops.filter((s) => s.where === 'host').length;
  const local = stops.length - host;
  if (!local) return `Postbox asked the agent’s host to stop its turn ${timesOf(host)}, and records nothing the turn did until the host confirmed`;
  if (!host) return `Postbox stopped the agent’s turn ${timesOf(local)}, and records nothing it did until the turn ended`;
  return `Postbox stopped the agent’s turn ${timesOf(stops.length)} (${timesOf(local)} on this computer, ${timesOf(host)} on its host), and records nothing a turn did until it ended or its host confirmed`;
}

/**
 * The note and extra a trajectory gets for its clock’s stops: none when it has none. A forced one voids the run too
 * (clockVoid, which clockScope adds).
 * @param {ClockStop[]} stops @returns {{ note: string|null, extra: Record<string, any> }}
 */
export function stopsScope(stops) {
  if (!stops.length) return { note: null, extra: {} };
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
  const at = (/** @type {number | null | undefined} */ ms) => (typeof ms === 'number' ? iso(ms) : null);
  return {
    note: `Partial: ${lead(stops)}: ${stops.map((s) => stopSaid(s, iso)).join('; ')}.`,
    extra: {
      stops: stops.map((s) => ({
        ...s,
        asked_at: at(s.asked_at),
        confirmed_at: at(s.confirmed_at),
        ...(s.gave_up_at === undefined ? {} : { gave_up_at: at(s.gave_up_at) }),
      })),
    },
  };
}

/** Why a void voided the run, in words. @type {Record<string, string>} */
const VOID_WORDS = {
  restored: 'Postbox started again with the run clock running, so the time it was down is unrecorded',
  watchdog: 'Postbox couldn’t confirm one of the agent’s stopped turns ended (watchdog), so the agent may have worked uncounted',
  unkilled: 'Postbox couldn’t confirm one of the agent’s stopped turns ended (unkilled), so the agent may have worked uncounted',
  restart: 'Postbox couldn’t confirm one of the agent’s stopped turns ended (restart), so the agent may have worked uncounted',
};

/**
 * The first thing in a session’s clock events that voids its timed run, or null: a forced stop, a restart with the
 * clock running, or an expiry carrying the clock’s `voided` (as a snapshot export rebuilds one, tools/atif-export.mjs).
 * @param {{ type: string, data: any }[]} clocks @returns {{ why: string, at: number | null } | null}
 */
export function clockVoid(clocks) {
  for (const c of clocks) {
    if (c.type === 'clock.stopped' && c.data.forced) return { why: c.data.why, at: c.data.at ?? null };
    if (c.type === 'clock.restored') return { why: 'restored', at: c.data.at ?? null };
    if (c.type === 'clock.expired' && c.data.voided) return { why: c.data.voided.why, at: c.data.voided.at ?? null };
  }
  return null;
}

/**
 * What a trajectory carries of its session’s clock: a note, when its run is partial or void, and in `extra` each clock
 * event with its words, the stops (stopsScope) and, if void, `clock_void`. Nothing when it had no clock.
 * @param {{ type: string, data: any }[]} clocks  the session’s clock events, in order @returns {{ note: string|null, extra: Record<string, any> }}
 */
export function clockScope(clocks) {
  if (!clocks.length) return { note: null, extra: {} };
  const iso = (/** @type {number | null} */ ms) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);
  const stops = stopsScope(clockStops(clocks));
  const voided = clockVoid(clocks);
  const said = voided ? `Void as a timed run: ${VOID_WORDS[voided.why] ?? `the clock says so (${voided.why})`}, and Postbox ended the run.` : null;
  const events = clocks.map((c) => ({ event: c.type, said: CLOCK_WORDS[c.type](c.data), ...c.data, at: iso(c.data.at) }));
  return {
    note: [said, stops.note].filter(Boolean).join(' ') || null,
    extra: { clock_events: events, ...stops.extra, ...(voided ? { clock_void: { why: voided.why, at: iso(voided.at) } } : {}) },
  };
}
