// A run’s budget (#290): --max-cost caps what the whole run spends, in dollars: its agents’ turns, the tester, the
// verifier and the telemetry report. Without it, only --budget caps the tester, as before.
//
// The cap is split before the run starts. The verifier and the telemetry report get AFTER_RUN_USD, held for after the
// last step. The tester gets its own --budget. The agents get the rest. Before each tester step, the runner checks
// that the step and the agent turn it may start both fit what’s left of their shares. Through the whole run, its watch
// (tools/uat/turns.mjs, watchBudget) reads the turns’ reported costs every 1.5 s, whatever the run is doing. Once the
// next step or turn could pass the cap, the run stops: it stops the newest turns at work until the rest fit, and any
// that starts after, takes no more steps, and writes its report, findings.json and run.json as any run does, saying
// that it stopped at its budget and what each spent.
//
// Where the cap can still be passed: each reservation is the largest cost seen so far, or the estimate below before
// there is one, so a step or turn costlier than every one before it can pass its reservation by the difference. A
// stopped turn reports nothing, so it’s charged a turn’s reservation, an estimate. A topic thread’s fork starts from
// its parent’s running total (tools/uat/cost.mjs), which counts again: that overstates, never understates. Only
// dollars count: Kiro credits, Antigravity tokens and Codex turns aren’t, nor Postbox’s own short summaries, which no
// stream records.

import { turnCosts } from './cost.mjs';
import { askOnce } from './tester.mjs';

/**
 * An agent turn’s reservation before any turn has reported: the largest turn in the recorded runs cost $0.62 (an Opus
 * agent in the mixedroom run of 23 October; Haiku turns cost under a cent), rounded up.
 */
export const AGENT_TURN_USD = 1;
/** A tester step’s reservation before the first: the least the tester lets one step spend (tools/uat/tester.mjs). */
export const TESTER_STEP_USD = 0.5;
/**
 * Held for the verifier and the telemetry report, after the last step. An estimate: no run recorded their cost before
 * this one (run.json’s budget now does). Each verifier call is also capped at what’s left of the whole cap.
 */
export const AFTER_RUN_USD = 1;
/** Less than this left, and the verifier isn’t asked: a call needs room to answer. */
const VERIFY_MIN_USD = 0.1;

const usd = (n) => `$${n.toFixed(2)}`;
const cents = (n) => Math.round(n * 100) / 100;

/**
 * --max-cost, read where it enters: null when it isn’t given, else a positive number of dollars.
 * @param {unknown} value
 */
export function parseMaxCost(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--max-cost takes a number of dollars above 0, such as --max-cost 20, not “${value}”.`);
  return n;
}

/** The budget of a run without --max-cost: nothing is reserved, checked or stopped. */
const OFF = {
  on: false,
  stopped: null,
  track() {},
  beforeStep: () => null,
  duringTurns: () => [],
  spend() {},
  verifier: () => undefined,
  summary: () => null,
};

/**
 * The budget for a run: OFF without --max-cost, else a RunBudget. Throws, before the run starts, when the cap can’t
 * hold the tester’s share, the after-run reserve and one agent turn.
 * @param {{ cap: number|null, testerShare: number, now?: () => number }} o  cap: --max-cost; testerShare: --budget
 */
export function runBudget({ cap, testerShare, now = () => Date.now() }) {
  if (cap === null) return OFF;
  if (!Number.isFinite(testerShare) || testerShare < 0) throw new Error(`--budget takes a number of dollars, not “${testerShare}”.`);
  const agentsShare = cap - testerShare - AFTER_RUN_USD;
  if (agentsShare < AGENT_TURN_USD)
    throw new Error(
      `--max-cost ${usd(cap)} leaves the agents ${usd(Math.max(0, agentsShare))} after the tester’s ${usd(testerShare)} (--budget) and ${usd(AFTER_RUN_USD)} for the verifier and telemetry, less than the ${usd(AGENT_TURN_USD)} an agent turn is reserved before one has reported. Raise --max-cost, or lower --budget.`,
    );
  return new RunBudget({ cap, testerShare, agentsShare, now });
}

export class RunBudget {
  on = true;
  /** @type {{ step: number, during: boolean, at: number, why: string } | null} */
  stopped = null;
  /** @type {() => any[]} */
  streams = () => [];
  tester = { spent: 0 };
  log = (/** @type {string} */ _line) => {};
  after = { verifier: 0, telemetry: 0 };
  /** What the verifier calls running now may spend: held from what’s left, so two at once can’t both spend it. */
  verifying = 0;
  testerBefore = 0;
  largestStep = 0;
  step = 0;
  /** @type {Map<string, number>} when the watch first saw each session at its turn: the newest is stopped first */
  since = new Map();
  /** @type {Set<string> | null} the sessions at work when the run stopped, and still at that turn */
  inFlight = null;

  /** @param {{ cap: number, testerShare: number, agentsShare: number, now: () => number }} o */
  constructor({ cap, testerShare, agentsShare, now }) {
    this.cap = cap;
    this.testerShare = testerShare;
    this.agentsShare = agentsShare;
    this.now = now;
  }

  /** What the run spends, once it has them: its agents’ recorded streams, its tester, and where to log. */
  track(/** @type {{ streams: () => any[], tester: { spent: number }, log?: (line: string) => void }} */ o) {
    this.streams = o.streams;
    this.tester = o.tester;
    if (o.log) this.log = o.log;
  }

  /**
   * What has been spent, with `working` turns still at work. A stream with no result is a turn at work, or one that
   * ended without reporting, as a stopped turn does: those past `working` are charged a turn’s reservation each, an
   * estimate, since their cost is never recorded.
   */
  spent(working = 0) {
    const streams = this.streams();
    const turns = turnCosts(streams);
    const reserve = turns.length ? Math.max(...turns.map((t) => t.usd)) : AGENT_TURN_USD;
    const silent = Math.max(0, streams.filter((s) => !(s.events ?? []).some((e) => e?.type === 'result')).length - working);
    const agents = turns.reduce((a, t) => a + t.usd, 0) + silent * reserve;
    return { turns, reserve, silent, agents, total: agents + this.tester.spent + this.after.verifier + this.after.telemetry };
  }

  /** The run stops here, once: the step it didn’t take, or whose turns it stopped, when, and why. */
  stop(step, during, why) {
    if (this.stopped) return this.stopped.why;
    this.stopped = { step, during, at: this.now(), why };
    this.log(`Stopped at the run’s budget (--max-cost ${usd(this.cap)}): ${why}`);
    return why;
  }

  /** Why `n` turns at work, or about to be, could take the agents past their share, or null. */
  agentsOver(n, working = 0) {
    const { turns, reserve, agents } = this.spent(working);
    if (agents + reserve * n <= this.agentsShare) return null;
    const what = n === 1 ? 'an agent turn reserves' : `${n} agent turns reserve`;
    return `the agents have spent ${usd(agents)} of their ${usd(this.agentsShare)}, and ${what} ${usd(reserve * n)} (${turns.length ? 'the largest turn so far' : 'the estimate before any turn reports'}).`;
  }

  /** Before tester step `step`, with `working` agents still at a turn: null to take it, or why the run stops. */
  beforeStep(/** @type {{ step: number, working: number }} */ { step, working }) {
    if (this.stopped) return this.stopped.why;
    this.largestStep = Math.max(this.largestStep, this.tester.spent - this.testerBefore);
    this.testerBefore = this.tester.spent;
    this.step = step;
    const reserve = this.largestStep || TESTER_STEP_USD;
    if (this.tester.spent + reserve > this.testerShare)
      return this.stop(
        step,
        false,
        `the tester has spent ${usd(this.tester.spent)} of its ${usd(this.testerShare)}, and a step reserves ${usd(reserve)} (${this.largestStep ? 'its largest so far' : 'the estimate before its first'}).`,
      );
    // The step may start an agent turn, and every turn still working may cost as much as the largest.
    const over = this.agentsOver(working + 1, working);
    return over ? this.stop(step, false, over) : null;
  }

  /**
   * The sessions to stop, of those at a turn (`working`), each time the runner’s watch polls. Past the budget, the
   * newest turns are stopped until those left fit it. Once the run has stopped, a turn at work then may finish if it
   * fits, and any turn that starts after is stopped.
   * @param {{ id: string }[]} working
   * @returns {string[]}
   */
  duringTurns(working) {
    const now = this.now();
    for (const id of this.since.keys()) if (!working.some((w) => w.id === id)) this.since.delete(id);
    for (const w of working) if (!this.since.has(w.id)) this.since.set(w.id, now);
    const over = this.agentsOver(working.length, working.length);
    if (over) this.stop(this.step, true, over);
    if (!this.stopped) return [];
    const { agents, reserve } = this.spent(working.length);
    const before = this.inFlight ?? new Set(working.map((w) => w.id));
    const keep = working.filter((w) => before.has(w.id)).sort((a, b) => (this.since.get(a.id) ?? 0) - (this.since.get(b.id) ?? 0));
    while (keep.length && agents + reserve * keep.length > this.agentsShare) keep.pop();
    this.inFlight = new Set(keep.map((w) => w.id));
    return working.filter((w) => !this.inFlight?.has(w.id)).map((w) => w.id);
  }

  /** What the verifier or the telemetry report spent. @param {'verifier'|'telemetry'} who  @param {unknown} amount */
  spend(who, amount) {
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) this.after[who] += amount;
  }

  /**
   * askOnce for the verifier, each call capped at what’s left of the whole cap, and its cost counted, failed or not.
   * The verifier’s calls run at once (tools/uat/review.mjs), so each holds its cap until it ends: the next gets what’s
   * left after that.
   */
  verifier(ask = askOnce) {
    return async (/** @type {any} */ args) => {
      const left = this.cap - this.spent().total - this.verifying;
      if (left < VERIFY_MIN_USD)
        throw new Error(`the run’s budget has ${usd(Math.max(0, left))} left, too little to verify. Verify later with --recheck <run> --verify yes.`);
      const hold = Math.min(args.budgetUsd ?? 2, left);
      this.verifying += hold;
      try {
        const r = await ask({ ...args, budgetUsd: hold });
        this.spend('verifier', r?.cost);
        return r;
      } catch (e) {
        this.spend('verifier', e?.cost);
        throw e;
      } finally {
        this.verifying -= hold;
      }
    };
  }

  /** For report.md, findings.json and run.json: the cap, its shares, what each spent, and whether the run stopped at it. */
  summary() {
    const { turns, reserve, silent, agents, total } = this.spent();
    /** @type {Record<string, number>} */
    const byAgent = {};
    for (const t of turns) if (t.handle) byAgent[t.handle] = (byAgent[t.handle] ?? 0) + t.usd;
    for (const h of Object.keys(byAgent)) byAgent[h] = cents(byAgent[h]);
    return {
      cap: this.cap,
      shares: { agents: cents(this.agentsShare), tester: cents(this.testerShare), afterRun: AFTER_RUN_USD },
      spent: {
        total: cents(total),
        agents: cents(agents),
        byAgent,
        // Turns that ended without reporting their cost, charged a turn’s reservation each.
        unreported: { turns: silent, usd: cents(silent * reserve) },
        tester: cents(this.tester.spent),
        verifier: cents(this.after.verifier),
        telemetry: cents(this.after.telemetry),
      },
      largest: { turn: turns.length ? cents(reserve) : null, step: this.largestStep ? cents(this.largestStep) : null },
      stopped: this.stopped,
    };
  }
}

/**
 * The report’s sentence on the budget, from a summary(), or nothing for a run without one.
 * @param {ReturnType<RunBudget['summary']> | null | undefined} b
 */
export function budgetNote(b) {
  if (!b) return '';
  const n = b.spent.unreported?.turns ?? 0;
  const parts = [
    ...Object.entries(b.spent.byAgent ?? {}).map(([h, usdOf]) => `@${h} ${usd(usdOf)}`),
    ...(n ? [`${usd(b.spent.unreported.usd)} estimated for ${n === 1 ? 'a turn' : `${n} turns`} stopped before reporting`] : []),
  ];
  const spentBy = `agents ${usd(b.spent.agents)}${parts.length ? ` (${parts.join(', ')})` : ''}, tester ${usd(b.spent.tester)}, verifier ${usd(b.spent.verifier)}, telemetry ${usd(b.spent.telemetry)}`;
  const when = b.stopped?.during ? `while step ${b.stopped.step}’s turns ran` : `before step ${b.stopped?.step}`;
  return ` Budget: ${usd(b.cap)} (--max-cost), of which it spent ${usd(b.spent.total)}: ${spentBy}.${b.stopped ? ` **It stopped at its budget** ${when}: ${b.stopped.why}` : ''}`;
}
