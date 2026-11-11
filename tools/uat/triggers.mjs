// Triggers: what a targeted scenario’s phase is there to cause, as deterministic predicates over what a run records
// (the same facts the checks read, tools/uat/checks.mjs). A check says whether Postbox got something wrong; a trigger
// says whether the run reached the code path at all. A P0 run that never made Postbox refuse an update over an unread
// answer hasn’t tested #123’s fix, however clean its checks are.
//
// A phase names its triggers (`- triggers: wake-full-text` in tests/uat/e2e/scenarios/p0.md). The runner moves on once
// they’ve all happened, or at the phase’s step cap, when it records a coverage gap. Each trigger reads:
//   facts.state      items: an allowed wake request and what the woken agent got (#108)
//   facts.streams    each agent turn’s raw stream: Postbox’s tool calls and what Postbox answered (#123, #125)
//   facts.events     the history: sessions’ background jobs and Stop’s question about them (#126)
//   facts.probes     what the runner saw on the page: a notice that Postbox refused an answer as stale (#123)

import { NEEDS_TRIGGERS } from '../../server/room-checks-needs.mjs';
import { ALLOW_ONCE_TRIGGERS } from './allowonce-triggers.mjs';
import { ASK_QUESTION_TRIGGERS } from './ask-question-triggers.mjs';
import { DELIVERY_TRIGGERS } from './delivery-triggers.mjs';
import { DISMISS_TRIGGERS } from './dismiss-triggers.mjs';
import { GIT_PUSH_TRIGGERS } from './gitpush-triggers.mjs';
import { REVIEW_FIGURE_TRIGGERS } from './review-figures-triggers.mjs';
import { cell as esc } from './trigger-facts.mjs';
import { HOST_TRIGGERS } from './triggers-host.mjs';
import { JOB_TRIGGERS } from './triggers-jobs.mjs';
import { MEASURE_TRIGGERS } from './triggers-measure.mjs';
import { P0_TRIGGERS } from './triggers-p0.mjs';
import { VIEW_TRIGGERS } from './view-triggers.mjs';
import { WAITING_TRIGGERS } from './waiting-triggers.mjs';

export { jobTimeline } from './triggers-jobs.mjs';

/**
 * The triggers, by id. `says` finishes “Postbox showed that …”, for the tester and the report. `run` returns the times
 * it happened, with evidence; `recorded` says whether this run’s records could show it at all (a run from before the
 * runner kept job history can’t show #126’s).
 * @type {Record<string, { issue: number, requirements?: string[], says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>}
 */
export const TRIGGERS = {
  ...P0_TRIGGERS,
  ...JOB_TRIGGERS,
  ...HOST_TRIGGERS,
  ...NEEDS_TRIGGERS,
  ...ALLOW_ONCE_TRIGGERS,
  ...GIT_PUSH_TRIGGERS,
  ...DELIVERY_TRIGGERS,
  ...VIEW_TRIGGERS,
  ...WAITING_TRIGGERS,
  ...MEASURE_TRIGGERS,
  ...REVIEW_FIGURE_TRIGGERS,
  ...DISMISS_TRIGGERS,
  ...ASK_QUESTION_TRIGGERS,
};

/**
 * Names in a scenario’s phases that aren’t triggers, so a run fails before it starts instead of waiting on one.
 * @param {{ phases: { triggers?: string[] }[] }} scenario
 */
export const unknownTriggers = (scenario) =>
  scenario.phases.flatMap((p) => [...(p.triggers ?? []), ...(p.hostTriggers ?? [])]).filter((t) => !Object.hasOwn(TRIGGERS, t));

/**
 * Which of these triggers have happened in what the run recorded so far: the first time each did, and its evidence.
 * Null for one this run’s records can’t show.
 * @param {any} facts  @param {string[]} ids
 * @returns {Record<string, { at: number|null, evidence: string } | false | null>}
 */
export function triggersFired(facts, ids, { onError = (_id, _e) => {} } = {}) {
  /** @type {Record<string, { at: number|null, evidence: string } | false | null>} */
  const out = {};
  for (const id of ids) {
    const t = TRIGGERS[id];
    if (!t) continue;
    try {
      const hits = t.run(facts);
      out[id] = hits.length ? hits.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))[0] : t.recorded(facts) ? false : null;
    } catch (e) {
      // A trigger that fails can’t say it didn’t happen: that would be a false coverage gap.
      onError(id, e);
      out[id] = null;
    }
  }
  return out;
}

/**
 * A coverage gap: the finding a run records when a phase’s triggers didn’t all happen. It isn’t a defect in Postbox:
 * it says which fix the run didn’t test.
 * @param {{ phase: number, title: string, missing: string[], why: string }} gap
 */
export function gapFinding({ phase, title, missing, why }) {
  const names = missing.map((id) => `“${id}”`).join(' and ');
  const issues = [...new Set(missing.map((id) => TRIGGERS[id]?.issue).filter(Boolean))];
  return {
    source: 'run',
    check: 'coverage-gap',
    key: `phase-${phase}:${missing.join(',')}`,
    issue: null,
    refs: issues,
    phase: title,
    title: `Phase ${phase}’s trigger${missing.length === 1 ? '' : 's'} ${names} never happened`,
    evidence: `${why} Postbox never showed that ${missing.map((id) => TRIGGERS[id]?.says ?? id).join('; or that ')}. So this run didn’t test the fix for ${issues.map((n) => `#${n}`).join(' or ')} (${title}).`,
    verdict: 'measurement',
    verdictBy: 'runner',
    note: 'Not a defect: a fix this run didn’t test.',
  };
}

const named = (/** @type {string} */ t) => ({ issue: TRIGGERS[t]?.issue ?? null, requirements: TRIGGERS[t]?.requirements ?? [] }); // a coverage row’s (#508)

/** The steps a phase gets after its triggers happen, to finish what it asks, before the run moves on by itself. */
export const GRACE = 2;

/**
 * Follows a targeted run’s phases (scenario.phases[].triggers): each step, after the run’s facts are fresh, `check`
 * says whether the current phase is done (all its triggers happened), out of steps (its cap), or still going, and
 * what to tell the tester. A phase without triggers is left to the tester, as before.
 * @param {{ phases: { title: string, triggers?: string[], steps?: number|null }[] }} scenario
 * @param {{ cap: (phase: any) => number|null, start?: number, log?: (line: string) => void }} opts
 */
export function phaseGoals(scenario, { cap, start = 0, log = () => {} }) {
  const all = [...new Set(scenario.phases.flatMap((p) => p.triggers ?? []))];
  /** @type {Map<string, { step: number|null, at: number|null, evidence: string }>} */
  const seen = new Map();
  /** @type {Map<number, number>} */
  const used = new Map();
  /** @type {Map<number, { done: boolean, step: number|null, used?: number, why: string|null }>} */
  const ended = new Map();
  /** @type {any[]} */
  const gaps = [];
  let unknown = new Set();
  let heldIn = -1;
  const label = (i) => `Phase ${i + 1}`;
  const missingIn = (i) => (scenario.phases[i]?.triggers ?? []).filter((t) => !seen.has(t));
  const gap = (i, why) => {
    const missing = missingIn(i).filter((t) => !unknown.has(t));
    ended.set(i, { done: false, step: null, why });
    if (missing.length) gaps.push(gapFinding({ phase: i + 1, title: scenario.phases[i].title, missing, why }));
  };
  const says = (ids) => ids.map((id) => TRIGGERS[id]?.says ?? id).join('; and that ');
  return {
    /** Reads the triggers from fresh facts. @param {any} facts @param {number|null} step */
    observe(facts, step) {
      const fired = triggersFired(facts, all, {
        onError: (id, e) => log(`The trigger ${id} failed, so this run can’t tell whether it happened: ${e.message}`),
      });
      unknown = new Set(Object.keys(fired).filter((id) => fired[id] === null));
      for (const [id, hit] of Object.entries(fired)) if (hit && !seen.has(id)) seen.set(id, { step, at: hit.at, evidence: hit.evidence });
    },
    /** The tester took a step in this phase. @param {number} phase */
    took(phase) {
      used.set(phase, (used.get(phase) ?? 0) + 1);
    },
    /**
     * Where the run stands at the start of a step. A phase whose triggers have happened isn’t cut off: the tester
     * finishes what it asks (approve the draft, check what the woken agent got) and says next_phase, or the run moves
     * on by itself after GRACE more steps. end: 'now' when the run should stop before this step.
     * @param {number} phase  @param {number} step
     * @returns {{ phase: number, note: string, end: 'now'|null }}
     */
    check(phase, step) {
      const notes = [];
      for (;;) {
        const ph = scenario.phases[phase];
        const limit = ph ? cap(ph) : null;
        if (!ph || limit === null) return { phase, note: notes.join(' '), end: null };
        const last = phase === scenario.phases.length - 1;
        const n = used.get(phase) ?? 0;
        const e = ended.get(phase);
        if (e?.done) {
          const left = GRACE - (n - /** @type {number} */ (e.used));
          if (left > 0) {
            notes.push(
              `${label(phase)}’s goal has happened. Finish what the phase asks, answer what’s waiting on you, then answer ${last ? 'done' : 'next_phase'}; the run moves on by itself after ${left} more step${left === 1 ? '' : 's'}.`,
            );
            return { phase, note: notes.join(' '), end: null };
          }
          if (last) return { phase, note: notes.join(' '), end: 'now' };
          phase++;
          notes.push(`The run moved on to ${label(phase)}.`);
          continue;
        }
        // A phase the tester left with its triggers missing: the gap is recorded, and the tester moves on.
        if (e) return { phase, note: notes.join(' '), end: null };
        const missing = missingIn(phase);
        if (!missing.length) {
          ended.set(phase, { done: true, step, used: n, why: null });
          const ev = (ph.triggers ?? []).map((t) => seen.get(t)?.evidence).filter(Boolean);
          notes.push(`${label(phase)} is done: Postbox showed that ${says(ph.triggers ?? [])}. (${ev.join(' ')})`);
          continue;
        }
        if (n < limit) {
          const left = limit - n;
          notes.push(
            `This phase is done when Postbox shows that ${says(missing)}. You have ${left} step${left === 1 ? '' : 's'} left in it to make that happen.`,
          );
          return { phase, note: notes.join(' '), end: null };
        }
        gap(phase, `In ${limit} steps,`);
        notes.push(`${label(phase)}’s goal didn’t happen in its ${limit} steps: Postbox never showed that ${says(missing)}. The run recorded a coverage gap.`);
        if (last) return { phase, note: notes.join(' '), end: 'now' };
        phase++;
        notes.push(`It moved on to ${label(phase)}.`);
      }
    },
    /**
     * The tester asked to move on (next_phase or done) from a phase with triggers that haven’t all happened. The first
     * time, the run says what’s missing and holds; a second time it moves on, and records the gap.
     * @param {number} phase
     * @returns {string|null}  why it’s held, or null to let it move on
     */
    leave(phase) {
      const ph = scenario.phases[phase];
      const missing = missingIn(phase);
      if (!ph || cap(ph) === null || ended.has(phase) || !missing.length) return null;
      if (heldIn !== phase) {
        heldIn = phase;
        return `Not yet: this phase is there to make Postbox show that ${says(missing)}, and it hasn’t. Try another way to cause it; ask again to move on anyway, and the run will record that this phase’s fix went untested.`;
      }
      gap(phase, `After ${used.get(phase) ?? 0} steps the tester moved on, and`);
      return null;
    },
    /** At the run’s end: every phase with triggers that didn’t all happen is a gap. @param {number} phase  where the run ended */
    finish(phase) {
      for (let i = start; i < scenario.phases.length; i++) {
        const ph = scenario.phases[i];
        if (cap(ph) === null || ended.has(i)) continue;
        if (!missingIn(i).length) ended.set(i, { done: true, step: null, why: null });
        else gap(i, i > phase ? `The run ended before phase ${i + 1},` : 'The run reached its step cap, and');
      }
    },
    /** The coverage gaps recorded so far, as findings. */
    gaps: () => gaps,
    /**
     * Coverage per phase and trigger, for the report and run.json.
     * @returns {{ phase: number, title: string, trigger: string, issue: number, requirements: string[], hit: boolean|null, step: number|null, steps: number, cap: number|null, evidence: string|null, skipped: boolean }[]}
     */
    coverage: () =>
      scenario.phases.flatMap((ph, i) =>
        (ph.triggers ?? []).map((t) => ({
          phase: i + 1,
          title: ph.title,
          trigger: t,
          ...named(t),
          hit: seen.has(t) ? true : unknown.has(t) ? null : false,
          step: seen.get(t)?.step ?? null,
          steps: used.get(i) ?? 0,
          cap: cap(ph),
          evidence: seen.get(t)?.evidence ?? null,
          skipped: i < start,
        })),
      ),
  };
}

/**
 * The report’s coverage section for a targeted run: each phase’s triggers, whether they happened and when, and, said
 * plainly, the fixes it didn’t test. Empty for a scenario with no triggers.
 * @param {ReturnType<ReturnType<typeof phaseGoals>['coverage']>} coverage
 * @param {{ rechecked?: boolean }} [opts]
 * @returns {string[]}  Markdown lines
 */
export function coverageSection(coverage, { rechecked = false } = {}) {
  if (!coverage?.length) return [];
  const when = (c) =>
    c.skipped && !c.hit
      ? 'skipped (the run started later)'
      : c.hit === null
        ? 'can’t tell: this run didn’t record it'
        : c.hit
          ? c.step === null
            ? 'yes'
            : `yes, by step ${c.step}`
          : '**never**';
  const untested = coverage.filter((c) => c.hit === false && !c.skipped);
  const unknown = coverage.filter((c) => c.hit === null && !c.skipped);
  return [
    '## Coverage',
    '',
    `Each phase ends once Postbox shows what it’s there to cause, or at its step cap. A trigger that never happened means the run didn’t reach that fix’s code, so it says nothing about the fix.${rechecked ? ' Rechecked runs don’t know the step each one happened at.' : ''}`,
    '',
    '| Phase | Trigger | Issue | What Postbox had to show | Happened | Steps used |',
    '|---|---|---|---|---|---|',
    ...coverage.map(
      (c) =>
        `| ${esc(c.title)} | ${c.trigger} | #${c.issue} | ${esc(TRIGGERS[c.trigger]?.says ?? '')} | ${when(c)} | ${rechecked ? '—' : `${c.steps}${c.cap ? ` of ${c.cap}` : ''}`} |`,
    ),
    '',
    untested.length
      ? `**Not tested by this run:** ${untested.map((c) => `#${c.issue} (${c.trigger})`).join(', ')}. Their triggers never happened, so this run didn’t exercise those fixes.`
      : unknown.length
        ? '**Every trigger this run could record happened.**'
        : '**Every trigger happened**, so the run reached each fix’s code.',
    ...(unknown.length
      ? [
          '',
          `**Can’t tell:** ${unknown.map((c) => `#${c.issue} (${c.trigger})`).join(', ')}. This run is from before the runner recorded what those triggers read.`,
        ]
      : []),
    '',
  ];
}
