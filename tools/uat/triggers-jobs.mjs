// What the history says about background jobs and Stop’s question about them (#126), for the triggers that read it
// (tools/uat/triggers.mjs): when each job ran, was asked about, kept or ended, and whether Stop ended its turn.

/**
 * Whether the history can show #126’s triggers: it keeps Stop’s question (stopAsk), which every turn on Postbox since
 * #126 clears when it ends. A run saved before the runner kept it can’t tell.
 */
export const jobsRecorded = (f) => (f.events ?? []).some((e) => e?.type === 'session' && e.data && Object.hasOwn(e.data, 'stopAsk'));

/**
 * What happened to each background job the history shows, by session, as event numbers: when it was first seen
 * running, when Stop asked about it while it ran, when Postbox kept it running, and when it ended. `afterStop` says
 * the turn was stopped from that question (Stop clears the question and marks the session stopping in one event)
 * before the job was kept or ended.
 * @param {any[]} events
 */
export function jobTimeline(events) {
  /** @type {Map<string, { sessionId: string, id: string, seen: number, askedAt: number|null, keptAt: number|null, endedAt: number|null, afterStop: boolean, stopAt: number|null }>} */
  const jobs = new Map();
  /** @type {Map<string, boolean>} */
  const asking = new Map();
  /** @type {Map<string, number>} the last event at which Stop, answering its question, stopped the session’s turn */
  const stopped = new Map();
  /** @type {Map<string, number|null>} when that was, by Postbox’s clock (the session’s updatedAt) */
  const stoppedTime = new Map();
  const fromStop = (r, seq) => r.askedAt !== null && (stopped.get(r.sessionId) ?? -1) >= r.askedAt && (stopped.get(r.sessionId) ?? -1) <= seq;
  for (const e of events ?? []) {
    if (e?.type !== 'session' || !e.data) continue;
    const d = e.data;
    if (Object.hasOwn(d, 'stopAsk')) {
      if (asking.get(d.id) && !d.stopAsk && d.state === 'stopping') {
        stopped.set(d.id, e.seq);
        stoppedTime.set(d.id, Number.isFinite(d.updatedAt) ? d.updatedAt : null);
      }
      asking.set(d.id, !!d.stopAsk);
    }
    if (!Array.isArray(d.jobs)) continue;
    for (const j of d.jobs) {
      const k = `${d.id}\n${j.id}`;
      if (!jobs.has(k)) jobs.set(k, { sessionId: d.id, id: j.id, seen: e.seq, askedAt: null, keptAt: null, endedAt: null, afterStop: false, stopAt: null });
      const r = /** @type {any} */ (jobs.get(k));
      if (d.stopAsk && j.state === 'running' && !j.kept && r.askedAt === null) r.askedAt = e.seq;
      if (j.kept && r.keptAt === null) {
        r.keptAt = e.seq;
        r.afterStop = fromStop(r, e.seq);
        if (r.afterStop) r.stopAt = stoppedTime.get(d.id) ?? null;
      }
    }
    // A job that left the list, or stopped running, without being kept has ended.
    for (const r of jobs.values()) {
      if (r.sessionId !== d.id || r.endedAt !== null || r.keptAt !== null) continue;
      const j = d.jobs.find((x) => x.id === r.id);
      if (j && j.state === 'running') continue;
      r.endedAt = e.seq;
      r.afterStop = fromStop(r, e.seq);
      if (r.afterStop) r.stopAt = stoppedTime.get(d.id) ?? null;
    }
  }
  return [...jobs.values()];
}

/**
 * Whether the runner answered “Stop it too” to the question about this job: an answer it recorded within a minute
 * after Postbox stopped the turn (the runner notes the time once its interrupt returns). Any such answer, when the
 * history has no time.
 * @param {any} f  @param {{ stopAt: number|null }} j
 */
export const answeredStop = (f, j) =>
  (f.probes?.interrupts ?? []).some(
    (p) =>
      typeof p?.answered === 'string' &&
      /^Stop/.test(p.answered) &&
      (j.stopAt === null || !Number.isFinite(p.at) || (p.at >= j.stopAt - 5000 && p.at <= j.stopAt + 60_000)),
  );
