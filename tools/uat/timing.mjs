// Where a run’s time goes: the agents’ turns, the tester’s model calls, the scripted waits and the verifier. Each
// step records its own, and the run’s report and run.json say the split, so a change meant to make runs faster can
// show what it saved (tools/uat-run.mjs records it).

/** The kinds of time a run records, as run.json names them. */
const KINDS = /** @type {const} */ (['agents', 'tester', 'waits', 'verifier']);
const STEP_KEYS = { agents: 'agentMs', tester: 'testerMs', waits: 'waitMs' };

/**
 * A run’s clock. `time(kind, fn)` runs fn and adds how long it took to that kind, and to the step `at` last named:
 * the agents’ time is the wait for the turns the step’s action started (from the action until they’re handed back or
 * settled), so it’s measured at the start of the next step and counted against the one before. Step 0 is the time
 * before the first action.
 * @param {() => number} [now]
 */
export function runTiming(now = Date.now) {
  /** @type {Map<number, { step: number, agentMs: number, testerMs: number, waitMs: number }>} */
  const steps = new Map();
  const totals = { agents: 0, tester: 0, waits: 0, verifier: 0 };
  let current = 0;
  const row = (n) => {
    if (!steps.has(n)) steps.set(n, { step: n, agentMs: 0, testerMs: 0, waitMs: 0 });
    return /** @type {{ step: number, agentMs: number, testerMs: number, waitMs: number }} */ (steps.get(n));
  };
  return {
    /** The step whose action runs next: what follows counts against it. @param {number} step */
    at(step) {
      current = step;
    },
    /**
     * @template T
     * @param {'agents'|'tester'|'waits'|'verifier'} kind  @param {() => Promise<T>} fn  @returns {Promise<T>}
     */
    async time(kind, fn) {
      const t0 = now();
      try {
        return await fn();
      } finally {
        const ms = now() - t0;
        totals[kind] += ms;
        if (kind in STEP_KEYS) row(current)[STEP_KEYS[kind]] += ms;
      }
    },
    /** For run.json and the report: the totals, each one’s share of the whole run, and every step’s. @param {number} totalMs */
    summary(totalMs) {
      const whole = Math.max(totalMs, 1);
      const counted = KINDS.reduce((s, k) => s + totals[k], 0);
      const share = Object.fromEntries([
        ...KINDS.map((k) => [k, Math.round((100 * totals[k]) / whole)]),
        ['other', Math.round((100 * Math.max(0, totalMs - counted)) / whole)],
      ]);
      return {
        totalMs,
        ...Object.fromEntries(KINDS.map((k) => [`${k}Ms`, totals[k]])),
        share,
        steps: [...steps.values()].sort((a, b) => a.step - b.step),
      };
    },
  };
}

const min = (ms) => `${(ms / 60000).toFixed(1)} min`;

/**
 * The report’s line for a run’s timing (a summary from runTiming), or nothing for a run recorded before it.
 * @param {any} t
 */
export function timingLine(t) {
  if (!t?.share) return '';
  const s = t.share;
  return ` Time: agents ${s.agents}%, tester ${s.tester}%, waits ${s.waits}%, verifier ${s.verifier}%, other ${s.other}% of ${min(t.totalMs)}; the verifier took ${min(t.verifierMs)}.`;
}
