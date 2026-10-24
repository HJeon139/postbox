// What the archived UAT runs say about how long a run should be, how often its findings are real, what a step costs,
// and whether targeted runs reach the code they’re for. Pure functions over the runs’ records (tools/uat/runs.mjs),
// so they can be tested on fixtures; tools/uat-stats.mjs prints them.
//
// Ported from the analysis of 22 October 2026 (curve.py), which set the 15-step default:
// - A finding counts once per run, at the step it was first seen: by its open issue if it matched one, else by its key
//   or title. Measurements aren’t findings. A runner’s own finding is “runner”, one about the agent’s work “agent”,
//   and the rest “product”.
// - The discovery rate at step s is the new product findings first seen at s over the runs that reached s, so a short
//   run doesn’t count as finding nothing after it ended.
// - The yield by step k is the sum of those rates up to k, as a share of the sum up to step 20, with a bootstrap over
//   runs (2,000 resamples) for its 95% interval.

import { verdictOf } from './verdicts.mjs';

/** What a finding is, for the curves: product, agent, runner, or null for a measurement. @param {any} f */
export function kindOf(f) {
  if (verdictOf(f) === 'measurement' || f.check === 'coverage-gap') return null;
  if (f.source === 'run') return 'runner';
  if (String(f.category ?? '').toLowerCase() === 'agent') return 'agent';
  return 'product';
}

/**
 * The step each distinct finding of a run was first seen at.
 * @param {{ findings: any[] }} run  @param {{ sources?: string[]|null, unmatched?: boolean }} [opts]
 * @returns {Map<string, { step: number, kind: string, known: boolean }>}
 */
export function firstSeen(run, { sources = null, unmatched = false } = {}) {
  /** @type {Map<string, { step: number, kind: string, known: boolean }>} */
  const first = new Map();
  for (const f of run.findings ?? []) {
    const kind = kindOf(f);
    if (!kind || !Number.isInteger(f.step)) continue;
    if (sources && !sources.includes(f.source)) continue;
    if (unmatched && f.issue) continue;
    const key = f.issue ? `#${f.issue}` : (f.key ?? f.title);
    const was = first.get(key);
    if (!was || f.step < was.step) first.set(key, { step: f.step, kind, known: !!f.issue });
  }
  return first;
}

/**
 * The discovery curve: at each step, the runs that reached it, the new findings first seen there, their rate, and the
 * rates summed so far. Arrays are indexed by step (index 0 unused).
 * @param {{ steps: number, findings: any[] }[]} runs
 * @param {{ max: number, kinds?: string[], sources?: string[]|null, unmatched?: boolean }} opts
 */
export function curve(runs, { max, kinds = ['product'], sources = null, unmatched = false }) {
  const at = Array(max + 1).fill(0);
  const fresh = Array(max + 1).fill(0);
  for (const r of runs) {
    for (let s = 1; s <= Math.min(r.steps, max); s++) at[s]++;
    for (const { step, kind } of firstSeen(r, { sources, unmatched }).values())
      if (kinds.includes(kind) && step >= 1 && step <= Math.min(r.steps, max)) fresh[step]++;
  }
  const rate = at.map((n, s) => (s && n ? fresh[s] / n : 0));
  const cum = [0];
  for (let s = 1; s <= max; s++) cum.push(cum[s - 1] + rate[s]);
  return { at, fresh, rate, cum };
}

/**
 * The rate over a range of steps: the new findings in it over the run-steps that reached it.
 * @param {{ at: number[], fresh: number[] }} c  @param {number} from  @param {number} to
 */
export function rateOver(c, from, to) {
  let n = 0;
  let k = 0;
  for (let s = from; s <= Math.min(to, c.at.length - 1); s++) {
    n += c.at[s];
    k += c.fresh[s];
  }
  return { rate: n ? k / n : null, runSteps: n, found: k, runsAtStart: c.at[from] ?? 0, runsAtEnd: c.at[Math.min(to, c.at.length - 1)] ?? 0 };
}

/** A seeded random number generator (mulberry32), so a refit prints the same intervals each time. @param {number} seed */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The share of the yield by step `norm` (20) that each step in `ks` reached, with a bootstrap 95% interval over runs.
 * @param {{ steps: number, findings: any[] }[]} runs
 * @param {{ ks?: number[], norm?: number, resamples?: number, seed?: number, max?: number }} [opts]
 * @returns {{ k: number, share: number, lo: number, hi: number }[] | null}  null when no resample found anything by `norm`
 */
export function yieldShare(runs, { ks = [5, 10, 15], norm = 20, resamples = 2000, seed = 1, max } = {}) {
  const top = max ?? Math.max(norm, ...runs.map((r) => r.steps));
  const at = (c, k) => c.cum[Math.min(k, top)];
  const pick = random(seed);
  /** @type {Record<number, number[]>} */
  const shares = Object.fromEntries(ks.map((k) => [k, []]));
  for (let b = 0; b < resamples; b++) {
    const sample = runs.map(() => runs[Math.floor(pick() * runs.length)]);
    const c = curve(sample, { max: top });
    const total = at(c, norm);
    if (total <= 0) continue;
    for (const k of ks) shares[k].push(k <= norm ? Math.min(at(c, k) / total, 1) : at(c, k) / total);
  }
  if (!shares[ks[0]].length) return null;
  // As the analysis printed it: the bootstrap’s median, and its 2.5th and 97.5th percentiles.
  return ks.map((k) => {
    const v = [...shares[k]].sort((x, y) => x - y);
    const n = v.length;
    return { k, share: v[Math.floor(n / 2)], lo: v[Math.floor(0.025 * n)], hi: v[Math.min(n - 1, Math.floor(0.975 * n))] };
  });
}

/**
 * How the findings were judged: a count per verdict, and the share of reviewed defect claims that were real
 * (confirmed or a duplicate of an open issue). Measurements aren’t claims.
 * @param {{ findings: any[] }[]} runs
 */
export function precision(runs) {
  /** @type {Record<string, number>} */
  const counts = {};
  let total = 0;
  for (const r of runs)
    for (const f of r.findings ?? []) {
      const v = verdictOf(f) ?? 'not reviewed';
      counts[v] = (counts[v] ?? 0) + 1;
      total++;
    }
  const claims = total - (counts.measurement ?? 0);
  const reviewed = claims - (counts['not reviewed'] ?? 0);
  const real = (counts.confirmed ?? 0) + (counts.duplicate ?? 0);
  return { counts, total, claims, reviewed, real, share: reviewed ? real / reviewed : null };
}

/**
 * What a step cost, per run: the agents’ and the tester’s dollars over its steps. Runs without costs are left out.
 * @param {{ run: string, steps: number, cost: { agents: number|null, tester: number|null } }[]} runs
 */
export function costPerStep(runs) {
  const per = runs
    .filter((r) => r.steps > 0 && (Number.isFinite(r.cost?.agents) || Number.isFinite(r.cost?.tester)))
    .map((r) => ({ run: r.run, usd: ((r.cost.agents ?? 0) + (r.cost.tester ?? 0)) / r.steps }))
    .sort((a, b) => a.usd - b.usd);
  if (!per.length) return null;
  return { runs: per.length, median: per[Math.floor(per.length / 2)].usd, min: per[0], max: per.at(-1) };
}

/**
 * For targeted runs: how often each trigger happened, and by which step.
 * @param {{ run: string, coverage: any[]|null }[]} runs
 * @returns {{ trigger: string, issue: number|null, runs: number, hit: number, unknown: number, steps: number[] }[]}
 */
export function triggerCoverage(runs) {
  /** @type {Map<string, { trigger: string, issue: number|null, runs: number, hit: number, unknown: number, steps: number[] }>} */
  const out = new Map();
  for (const r of runs)
    for (const c of r.coverage ?? []) {
      if (c.skipped) continue;
      const t = out.get(c.trigger) ?? { trigger: c.trigger, issue: c.issue ?? null, runs: 0, hit: 0, unknown: 0, steps: [] };
      t.runs++;
      if (c.hit === true) t.hit++;
      if (c.hit === null) t.unknown++;
      if (c.hit === true && Number.isInteger(c.step)) t.steps.push(c.step);
      out.set(c.trigger, t);
    }
  return [...out.values()];
}

/** When a run started, from its folder’s name (the runner names it for the UTC time: 2026-10-23T21-18-25-p0). */
const runTime = (run) => {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(run);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : null;
};

/**
 * Each issue a run caught again, as tests/uat/e2e/README.md (“Recurring findings”) counts them: findings whose verdict
 * is duplicate by verdictOf(), each issue once per run; measurements and coverage rows aren’t defects. A closed
 * issue’s row counts only what came back after it closed: a run from before it closed, or one without its fix
 * (closedIssue.hasFix false), caught the defect as it was, not a recurrence (#213). Without gh, nothing is known about
 * closing, so every run counts. Sorted by runs, then findings.
 * @param {{ run: string, findings: any[] }[]} runs
 * @param {Map<number, { state: string, closedAt?: string|null, priority?: string|null }>} [issues]  from gh; empty without it
 */
export function recurrence(runs, issues = new Map()) {
  /** @type {Map<number, { issue: number, runs: Set<string>, findings: number, after: Set<string> }>} */
  const rows = new Map();
  for (const r of runs)
    for (const f of r.findings ?? []) {
      const n = f.duplicateOf ?? f.issue;
      if (verdictOf(f) !== 'duplicate' || f.check === 'coverage-gap' || f.closedIssue?.hasFix === false || !Number.isInteger(n)) continue;
      const closed = issues.get(n)?.closedAt ? Date.parse(String(issues.get(n)?.closedAt)) : null;
      const at = runTime(r.run);
      if (closed !== null && at !== null && at <= closed) continue;
      const row = rows.get(n) ?? { issue: n, runs: new Set(), findings: 0, after: new Set() };
      row.runs.add(r.run);
      row.findings++;
      if (closed !== null && at !== null) row.after.add(r.run);
      rows.set(n, row);
    }
  return [...rows.values()]
    .map((x) => ({ ...x, runs: x.runs.size, after: issues.has(x.issue) ? x.after.size : null, ...issues.get(x.issue) }))
    .sort((a, b) => b.runs - a.runs || b.findings - a.findings || a.issue - b.issue);
}

export const RECURRENCE_COLUMNS = ['Issue', 'State', 'Priority', 'Runs', 'Findings', 'Runs after close'];

/** The recurrence table, as lines of text. @param {ReturnType<typeof recurrence>} rows */
export function recurrenceTable(rows) {
  if (!rows.length) return ['Recurrence by issue: no run caught a known issue again.'];
  const cells = rows.map((x) => [`#${x.issue}`, x.state?.toLowerCase() ?? '?', x.priority ?? '—', x.runs, x.findings, x.after ?? '?'].map(String));
  const width = RECURRENCE_COLUMNS.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const line = (r) => `  ${r.map((c, i) => c.padEnd(width[i])).join('  ')}`.trimEnd();
  return [
    'Recurrence by issue (tests/uat/e2e/README.md, “Recurring findings”): an open issue in 2 or more runs goes up one priority, once; a closed one caught after it closed is verified against the run’s commit.',
    line(RECURRENCE_COLUMNS),
    ...cells.map(line),
  ];
}

// ── The printout ───────────────────────────────────────────────────────────────────────────

/** Below these, the numbers are printed with a plain warning, or not at all. */
export const THIN = { runs: 5, atNorm: 3, reviewed: 10, ciWidth: 0.3 };

const pct = (x) => `${Math.round(x * 100)}%`;
const usd = (x) => `$${x.toFixed(2)}`;
const BUCKETS = [
  [1, 5],
  [6, 10],
  [11, 15],
  [16, 20],
];

/**
 * One group’s summary, as lines of text.
 * @param {string} title  @param {any[]} runs  @param {{ resamples?: number }} [opts]
 */
export function summarize(title, runs, { resamples = 2000 } = {}) {
  const lines = [`${title}: ${runs.length} run${runs.length === 1 ? '' : 's'}`];
  if (!runs.length) return lines;
  const max = Math.max(20, ...runs.map((r) => r.steps));
  if (runs.length < THIN.runs)
    lines.push(`  Too thin to conclude anything: ${runs.length} run${runs.length === 1 ? '' : 's'}. The numbers below are only a record.`);
  const tester = curve(runs, { max, sources: ['tester'], unmatched: true });
  const any = curve(runs, { max });
  const row = (c) =>
    BUCKETS.map(([a, b]) => {
      const r = rateOver(c, a, b);
      return `${a}–${b}: ${r.rate === null ? 'no runs' : `${r.rate.toFixed(2)} (${r.runsAtStart}→${r.runsAtEnd} runs)`}`;
    }).join(' · ');
  lines.push('  Discovery per step, over the runs that reached each step:');
  lines.push(`    the tester’s new findings (product, no open issue): ${row(tester)}`);
  lines.push(`    every distinct product finding (tester and checks): ${row(any)}`);
  const reached = any.at[20] ?? 0;
  if (reached < THIN.atNorm) lines.push(`  Share of the 20-step yield: too few runs reached step 20 (${reached}) to estimate it.`);
  else {
    const y = yieldShare(runs, { resamples, max });
    if (!y) lines.push('  Share of the 20-step yield: nothing was found by step 20, so there’s no yield to share.');
    else {
      lines.push(
        `  Share of the 20-step yield reached by ${y.map((s) => `step ${s.k}: ${pct(s.share)} (95% CI ${pct(s.lo)}–${pct(s.hi)})`).join(', ')}; ${reached} runs reached step 20.`,
      );
      if (y.some((s) => s.hi - s.lo > THIN.ciWidth)) lines.push(`    Some intervals are wider than ${pct(THIN.ciWidth)}: too wide to set a cap from.`);
    }
  }
  const p = precision(runs);
  const order = ['confirmed', 'duplicate', 'harness', 'agent', 'by-design', 'not-reproduced', 'measurement', 'not reviewed'];
  const counts = order
    .filter((v) => p.counts[v])
    .map((v) => `${v} ${p.counts[v]} (${pct(p.counts[v] / p.total)})`)
    .join(', ');
  lines.push(`  Verdicts on ${p.total} findings: ${counts || 'none'}.`);
  lines.push(
    p.reviewed < THIN.reviewed
      ? `    Precision: too few reviewed (${p.reviewed} of ${p.claims} defect claims) to estimate it.`
      : `    Precision: ${pct(/** @type {number} */ (p.share))} of ${p.reviewed} reviewed defect claims were real (confirmed or a known issue).`,
  );
  const confirmedAt = runs
    .flatMap((r) => (r.findings ?? []).filter((f) => verdictOf(f) === 'confirmed' && Number.isInteger(f.step)).map((f) => f.step))
    .sort((a, b) => a - b);
  if (confirmedAt.length) lines.push(`    Confirmed findings were first seen at steps ${confirmedAt.join(', ')}.`);
  const cost = costPerStep(runs);
  lines.push(
    cost
      ? `  Cost per step (agents and tester): median ${usd(cost.median)}, from ${usd(cost.min.usd)} (${cost.min.run}) to ${usd(cost.max.usd)} (${cost.max.run}), over ${cost.runs} runs.`
      : '  Cost per step: no run recorded its cost.',
  );
  const cov = triggerCoverage(runs);
  if (runs.some((r) => r.kind === 'targeted'))
    if (!cov.length) lines.push('  Coverage per trigger: no run here recorded it (run them, or --recheck them, with this runner).');
    else
      for (const t of cov)
        lines.push(
          `  Coverage: ${t.trigger} (#${t.issue}) happened in ${t.hit} of ${t.runs - t.unknown} runs that recorded it${t.unknown ? ` (${t.unknown} more couldn’t tell)` : ''}${t.steps.length ? `, by step ${t.steps.sort((a, b) => a - b).join(', ')}` : ''}.`,
        );
  return lines;
}

/**
 * The whole printout: every run together (as the 22 October analysis counted them), then by scenario kind, then by
 * kind and the agents’ model, so a refit can tell Haiku runs from runs on the personas’ models.
 * @param {any[]} runs  @param {{ resamples?: number, roots?: string[], unfinished?: number, unreadable?: string[] }} [opts]
 */
export function report(runs, { resamples = 2000, roots = [], unfinished = 0, unreadable = [] } = {}) {
  const out = [
    `UAT stats: ${runs.length} finished run${runs.length === 1 ? '' : 's'}${roots.length ? ` in ${roots.join(', ')}` : ''}${unfinished ? ` (${unfinished} unfinished, skipped)` : ''}.`,
    ...unreadable.map((m) => `Left out, unreadable: ${m}`),
    '',
  ];
  if (!runs.length) return [...out, 'No finished runs: nothing to fit.'];
  const model = (r) => r.agents?.model ?? 'unknown model';
  // Live reports count toward recurrence only: no verifier judged them, and a live room has no steps (R20).
  const groups = [['All runs', runs.filter((r) => r.kind !== 'live')]];
  for (const kind of ['exploratory', 'targeted']) {
    const of = runs.filter((r) => r.kind === kind);
    if (!of.length) continue;
    if (of.length < runs.length) groups.push([`${kind[0].toUpperCase()}${kind.slice(1)} runs`, of]);
    const models = [...new Set(of.map(model))].sort();
    if (models.length > 1)
      for (const m of models) groups.push([`${kind[0].toUpperCase()}${kind.slice(1)} runs, agents on ${m}`, of.filter((r) => model(r) === m)]);
  }
  for (const [title, of] of groups) out.push(...summarize(/** @type {string} */ (title), /** @type {any[]} */ (of), { resamples }), '');
  out.push(
    'Runs: ' +
      runs
        .map((r) => `${r.run} (${r.kind}, ${model(r)}${r.agents?.effort ? ` at ${r.agents.effort}` : ''}, ${r.steps} steps)`)
        .join('; ')
        .concat('.'),
  );
  return out;
}
