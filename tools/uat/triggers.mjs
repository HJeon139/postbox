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

import { POSTBOX_SERVER } from '../../server/adapters/setup.mjs';
import { NEEDS_TRIGGERS } from '../../server/room-checks-needs.mjs';
import { TELEMETRY_TRIGGERS } from './telemetry-triggers.mjs';
import { clip, itemsOf, resultText } from './trigger-facts.mjs';

const timeOf = (ts) => {
  const n = typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Every Postbox tool call in the recorded streams, with what Postbox answered.
 * @param {{ handle: string, events: any[], started?: number }[]} streams
 * @returns {{ handle: string, name: string, input: any, at: number|null, error: boolean, text: string }[]}
 */
export function postboxCalls(streams) {
  const prefix = `mcp__${POSTBOX_SERVER}__`;
  const out = [];
  for (const s of streams ?? []) {
    const results = new Map();
    for (const e of s.events ?? [])
      if (e?.type === 'user')
        for (const b of Array.isArray(e.message?.content) ? e.message.content : []) if (b?.type === 'tool_result') results.set(b.tool_use_id, b);
    for (const e of s.events ?? []) {
      if (e?.type !== 'assistant') continue;
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type !== 'tool_use' || !String(b.name ?? '').startsWith(prefix)) continue;
        const r = results.get(b.id);
        out.push({
          handle: s.handle,
          name: String(b.name).slice(prefix.length),
          input: b.input ?? {},
          at: timeOf(e.timestamp) ?? (Number.isFinite(s.started) ? /** @type {number} */ (s.started) : null),
          error: r?.is_error === true,
          text: resultText(r),
        });
      }
    }
  }
  return out;
}

/**
 * Whether the history can show #126’s triggers: it keeps Stop’s question (stopAsk), which every turn on Postbox since
 * #126 clears when it ends. A run saved before the runner kept it can’t tell.
 */
const jobsRecorded = (f) => (f.events ?? []).some((e) => e?.type === 'session' && e.data && Object.hasOwn(e.data, 'stopAsk'));

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
const answeredStop = (f, j) =>
  (f.probes?.interrupts ?? []).some(
    (p) =>
      typeof p?.answered === 'string' &&
      /^Stop/.test(p.answered) &&
      (j.stopAt === null || !Number.isFinite(p.at) || (p.at >= j.stopAt - 5000 && p.at <= j.stopAt + 60_000)),
  );

/**
 * The triggers, by id. `says` finishes “Postbox showed that …”, for the tester and the report. `run` returns the times
 * it happened, with evidence; `recorded` says whether this run’s records could show it at all (a run from before the
 * runner kept job history can’t show #126’s).
 * @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>}
 */
export const TRIGGERS = {
  'wake-full-text': {
    issue: 108,
    says: 'an allowed wake delivered the agent’s whole message, longer than the request’s 200-character preview',
    recorded: (f) => !!f.state,
    run: (f) => {
      const items = itemsOf(f);
      return items
        .filter((it) => it.kind === 'hop' && it.status === 'allowed' && typeof it.text === 'string' && it.text.length > 200)
        .flatMap((hop) => {
          const got = items.find(
            (x) =>
              x.kind === 'agent' &&
              x.sessionId === hop.fromSessionId &&
              x.text === hop.text &&
              (x.at ?? 0) >= (hop.at ?? 0) &&
              f.state.threads?.[x.threadId]?.kind === 'side',
          );
          return got
            ? [
                {
                  at: Number.isFinite(got.at) ? got.at : null,
                  evidence: `@${hop.from}’s ${hop.text.length.toLocaleString('en-US')}-character message reached @${hop.to} whole once the wake was allowed.`,
                },
              ]
            : [];
        });
    },
  },
  'update-over-unread': {
    issue: 123,
    says: 'it refused update_block over an answer the agent hadn’t read yet',
    recorded: (f) => Array.isArray(f.streams),
    run: (f) =>
      postboxCalls(f.streams)
        .filter((c) => c.name === 'update_block' && /The person answered revision \d+ of .+ Their answer stays on screen/.test(c.text))
        .map((c) => ({
          at: c.at,
          evidence: `@${c.handle}’s update_block of “${clip(c.input?.block?.id ?? c.input?.id, 60)}” was refused: “${clip(c.text, 160)}”`,
        })),
  },
  'stale-answer': {
    issue: 123,
    says: 'it refused an answer from the person’s page because the block had changed since they read it',
    recorded: (f) => Array.isArray(f.probes?.stale),
    run: (f) =>
      (f.probes?.stale ?? []).map((p) => ({
        at: Number.isFinite(p.at) ? p.at : null,
        evidence: `The page refused the answer to ${p.key}: “${clip(p.text, 160)}”`,
      })),
  },
  'repeated-block-id': {
    issue: 125,
    says: 'it refused show_block for an id the agent already showed',
    recorded: (f) => Array.isArray(f.streams),
    run: (f) =>
      postboxCalls(f.streams)
        .filter((c) => c.name === 'show_block' && /^Block .+ is already shown\./.test(c.text))
        .map((c) => ({ at: c.at, evidence: `@${c.handle}’s show_block was refused: “${clip(c.text, 160)}”` })),
  },
  'stop-keep-jobs': {
    issue: 126,
    says: 'Stop asked about a background job, and the person kept it running',
    recorded: jobsRecorded,
    run: (f) =>
      jobTimeline(f.events)
        .filter((j) => j.keptAt !== null && j.afterStop)
        .map((j) => ({ at: null, evidence: `Stop asked about background job ${j.id}, and Postbox kept it running (events ${j.askedAt}–${j.keptAt}).` })),
  },
  'stop-jobs-too': {
    issue: 126,
    says: 'Stop asked about a background job, and the person stopped it too',
    recorded: jobsRecorded,
    run: (f) =>
      // A job Postbox couldn’t keep also ends with its turn, so the runner’s own record of the answer has to agree.
      jobTimeline(f.events)
        .filter((j) => j.endedAt !== null && j.afterStop && answeredStop(f, j))
        .map((j) => ({ at: j.stopAt, evidence: `Stop asked about background job ${j.id}, and it ended with the turn (event ${j.endedAt}).` })),
  },
  'send-now-job-running': {
    issue: 126,
    says: 'Send now interrupted a turn with a background job running, and the job kept running without a question',
    recorded: jobsRecorded,
    run: (f) =>
      jobTimeline(f.events)
        .filter((j) => j.keptAt !== null && !j.afterStop)
        .map((j) => ({
          at: null,
          evidence: `Background job ${j.id} was kept running when its turn was interrupted, with no question from Stop (event ${j.keptAt}).`,
        })),
  },
  ...TELEMETRY_TRIGGERS,
  ...NEEDS_TRIGGERS,
};

/**
 * Names in a scenario’s phases that aren’t triggers, so a run fails before it starts instead of waiting on one.
 * @param {{ phases: { triggers?: string[] }[] }} scenario
 */
export const unknownTriggers = (scenario) => scenario.phases.flatMap((p) => p.triggers ?? []).filter((t) => !Object.hasOwn(TRIGGERS, t));

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
     * @returns {{ phase: number, title: string, trigger: string, issue: number, hit: boolean|null, step: number|null, steps: number, cap: number|null, evidence: string|null, skipped: boolean }[]}
     */
    coverage: () =>
      scenario.phases.flatMap((ph, i) =>
        (ph.triggers ?? []).map((t) => ({
          phase: i + 1,
          title: ph.title,
          trigger: t,
          issue: TRIGGERS[t]?.issue ?? null,
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
  const esc = (s) =>
    String(s ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
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
