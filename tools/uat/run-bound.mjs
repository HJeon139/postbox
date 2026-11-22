// A run’s bound: every UAT run stops at a cap on its agents’ turns and on its wall time, whatever harness its agents
// run on. The dollar cap (--max-cost, tools/uat/budget.mjs) sees only what reports dollars: Claude Code’s turns, the
// tester and the verifier. Codex reports tokens (on a ChatGPT plan, no dollars at all), Kiro credits and Antigravity
// nothing it can add up (tools/uat/cost.mjs, uncosted), so a room of them was bounded only by --steps, and a reply-back
// loop between agents takes no steps: the real-q1 run of 8 November had 408 turn streams in 4 steps.
//
// Turns are counted where every harness’s turn starts, in Postbox: a session’s lastTurnId (server/turn-run.mjs,
// atWork), read with the state every 1.5 s. Once --max-turns turns have started, the run takes no more steps, and any
// turn that starts after is stopped. Past --max-minutes from the run’s start, it takes no more steps and stops the
// turns at work. Either way it writes its report, findings.json and run.json as any run does, saying where it stopped.
//
// Where it can still be passed: a session whose turn starts and is followed by its next within one poll counts once,
// and a turn that starts within a poll of the cap runs until that poll. The run’s report and verifier come after the
// wall time; the verifier is bounded by --max-cost and --budget, not by this.

import { watchBudget } from './turns.mjs';

/** Above the most turn streams of any recorded run but a looping one: p0 of 6 November had 132 in 28 steps. */
export const DEFAULT_MAX_TURNS = 150;
/** Above the longest recorded run, p0 of 6 November at 38 minutes; 99 in 100 of 318 runs took under 14. */
export const DEFAULT_MAX_MINUTES = 45;

/**
 * A whole number from 1 to `most`, read where it enters, or the default when it isn’t given.
 * @param {unknown} value @param {string} flag @param {number} fallback @param {number} most
 */
function count(value, flag, fallback, most) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > most) throw new Error(`${flag} takes a whole number from 1 to ${most}, not “${value}”.`);
  return n;
}

/**
 * The bound for a run, from --max-turns and --max-minutes.
 * @param {{ turns?: unknown, minutes?: unknown, now?: () => number }} o
 */
export function runBound({ turns, minutes, now = () => Date.now() }) {
  return new RunBound({
    maxTurns: count(turns, '--max-turns', DEFAULT_MAX_TURNS, 10_000),
    maxMinutes: count(minutes, '--max-minutes', DEFAULT_MAX_MINUTES, 24 * 60),
    now,
  });
}

/** Why the turn cap stopped a run. @param {number} n */
const capped = (n) => `its agents started ${n === 1 ? 'a turn' : `${n} turns`}, the most --max-turns ${n} allows.`;

export class RunBound {
  /** @type {{ step: number, at: number, why: string } | null} */
  stopped = null;
  /** @type {Set<string>} every turn seen to start, by its id */
  turns = new Set();
  /** @type {Set<string> | null} the turns that started before the cap was reached: those may finish */
  allowed = null;
  step = 0;

  /** @param {{ maxTurns: number, maxMinutes: number, now: () => number }} o */
  constructor({ maxTurns, maxMinutes, now }) {
    this.maxTurns = maxTurns;
    this.maxMinutes = maxMinutes;
    this.now = now;
    this.startedAt = now();
  }

  /** The run stops here, once: the step it was at, when, and why. */
  stop(why) {
    if (this.stopped) return this.stopped.why;
    this.stopped = { step: this.step, at: this.now(), why };
    return why;
  }

  /** Why the wall time is up, or null. */
  late() {
    const minutes = (this.now() - this.startedAt) / 60000;
    return minutes >= this.maxMinutes ? `it ran ${Math.floor(minutes)} minutes, past --max-minutes ${this.maxMinutes}.` : null;
  }

  /**
   * Reads the sessions’ latest turns. Returns the sessions to stop, of those at a turn: every one once the wall time
   * is up, else each whose turn started after the turn cap was reached.
   * @param {{ id: string, lastTurnId?: string | null, state?: string }[]} sessions  every session in the run’s Postbox
   * @returns {string[]}
   */
  see(sessions) {
    for (const se of sessions) if (se.lastTurnId && this.turns.size < this.maxTurns) this.turns.add(se.lastTurnId);
    const working = sessions.filter((se) => ['think', 'tool', 'gen'].includes(se.state ?? ''));
    const late = this.late();
    if (late) {
      this.stop(late);
      return working.map((se) => se.id);
    }
    const past = sessions.some((se) => se.lastTurnId && !this.turns.has(se.lastTurnId));
    if (this.turns.size >= this.maxTurns && past) this.stop(capped(this.maxTurns));
    if (this.turns.size >= this.maxTurns) this.allowed ??= new Set(this.turns);
    const allowed = this.allowed;
    return allowed ? working.filter((se) => se.lastTurnId && !allowed.has(se.lastTurnId)).map((se) => se.id) : [];
  }

  /** Before tester step `step`: null to take it, or why the run stops. */
  beforeStep(step) {
    this.step = step;
    if (this.stopped) return this.stopped.why;
    const late = this.late();
    if (late) return this.stop(late);
    return this.turns.size >= this.maxTurns ? this.stop(capped(this.maxTurns)) : null;
  }

  /** For report.md, findings.json and run.json. */
  summary() {
    return {
      maxTurns: this.maxTurns,
      maxMinutes: this.maxMinutes,
      turns: this.turns.size,
      minutes: Math.round(((this.now() - this.startedAt) / 60000) * 10) / 10,
      stopped: this.stopped,
    };
  }
}

/**
 * The report’s sentence on the bound, said only when the run stopped at it. @param {ReturnType<RunBound['summary']> | null | undefined} b
 */
export const boundNote = (b) => (b?.stopped ? ` **It stopped at its bound** at step ${b.stopped.step}: ${b.stopped.why}` : '');

/**
 * The run’s watches, every 1.5 s until ended, whatever the run is doing: the bound’s, on every harness, and the dollar
 * budget’s (tools/uat/turns.mjs, watchBudget), with --max-cost. Returns the function that ends both.
 * @param {{ bound: RunBound, budget: any, api: (path: string) => Promise<any>, threadsUnderTest: (st: any) => string[], stop: (id: string) => Promise<unknown>, log?: (line: string) => void, every?: number }} o
 */
export function watchRun({ bound, budget, api, threadsUnderTest, stop, log = () => {}, every = 1500 }) {
  const unbudget = watchBudget({ budget, api, threadsUnderTest, stop, log, every });
  let ended = false;
  let failed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const poll = async () => {
    try {
      const st = (await api('/api/state')).state;
      const was = bound.stopped;
      const ids = bound.see(Object.values(st.sessions ?? {}));
      if (!was && bound.stopped) log(`Stopped at the run’s bound: ${bound.stopped.why}`);
      for (const id of ids) {
        log(`bound: stopping @${st.sessions[id]?.handle ?? id}’s turn`);
        await stop(id);
      }
    } catch (e) {
      if (!failed) log(`The run’s bound couldn’t check the agents’ turns, and will keep trying: ${e.message}`);
      failed = true;
    }
    if (!ended) timer = setTimeout(poll, every);
  };
  timer = setTimeout(poll, every);
  return () => {
    ended = true;
    clearTimeout(timer);
    unbudget();
  };
}
