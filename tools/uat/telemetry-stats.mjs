// What the runs say about telemetry (designs/telemetry-persona.md, U5, R20), for tools/uat-stats.mjs: totals of each
// UAT run’s run.json telemetry block, and how the classifier’s attribution agrees with the verifier’s verdicts. Live
// reports (kind "live", read from a Postbox folder’s telemetry/) count toward recurrence only: no verifier judged them,
// and a live room has no steps.

import { verdictOf } from './verdicts.mjs';

const pct = (x) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
/** The verifier’s verdict in the classifier’s words: Postbox’s (a known issue is too), the agent’s, or on purpose. */
const AS_ATTRIBUTION = { confirmed: 'confirmed', duplicate: 'confirmed', agent: 'agent', 'by-design': 'by-design' };

/** Cohen’s κ for two raters over the same items. */
function kappa(pairs) {
  const n = pairs.length;
  const cats = [...new Set(pairs.flat())];
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pe = cats.reduce((s, c) => s + (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

/**
 * The totals across UAT runs that recorded themselves.
 * @param {{ kind: string, telemetry?: any, findings: any[], proposals?: any[] }[]} runs
 */
export function telemetryTotals(runs) {
  const uat = runs.filter((r) => r.kind !== 'live' && r.telemetry);
  const pairs = uat.flatMap((r) =>
    r.findings
      .filter((f) => f.telemetry?.attribution && AS_ATTRIBUTION[verdictOf(f) ?? ''])
      .map((f) => [f.telemetry.attribution, AS_ATTRIBUTION[verdictOf(f) ?? '']]),
  );
  const why = {};
  for (const r of uat) for (const [k, v] of Object.entries(r.telemetry.unlabeledWhy ?? {})) why[k] = (why[k] ?? 0) + v;
  const unverified = {};
  for (const r of uat) for (const u of r.telemetry.unverified ?? []) unverified[u.check] = (unverified[u.check] ?? 0) + (u.count ?? 1);
  const proposals = uat.flatMap((r) => r.proposals ?? []);
  const judged = proposals.filter((p) => verdictOf(p));
  return {
    runs: uat.length,
    saved: uat.filter((r) => r.telemetry.saved).length,
    recall: mean(uat.map((r) => r.telemetry.recall).filter((x) => x !== null && x !== undefined)),
    pinning: mean(uat.map((r) => r.telemetry.pinning).filter((x) => x !== null && x !== undefined)),
    agreement: pairs.length ? pairs.filter(([a, b]) => a === b).length / pairs.length : null,
    kappa: pairs.length >= 30 ? kappa(pairs) : null,
    pairs: pairs.length,
    labels: uat.reduce((a, r) => a + (r.telemetry.labels ?? 0), 0),
    unlabeled: mean(uat.map((r) => r.telemetry.unlabeled).filter((x) => x !== null && x !== undefined)),
    why,
    unverified,
    proposals: proposals.length,
    proposalPrecision: judged.length ? judged.filter((p) => ['confirmed', 'duplicate'].includes(verdictOf(p) ?? '')).length / judged.length : null,
    costUsd: uat.reduce((a, r) => a + (r.telemetry.classifier?.costUsd ?? 0), 0),
    live: runs.filter((r) => r.kind === 'live').length,
  };
}

/** The totals, as lines of text. @param {ReturnType<typeof telemetryTotals>} t */
export function telemetryLines(t) {
  if (!t.runs && !t.live) return ['Telemetry: no run here recorded itself.'];
  return [
    `Telemetry: ${t.runs} UAT runs recorded themselves, ${t.saved} saved a report${t.live ? `; ${t.live} live reports count toward recurrence only` : ''}.`,
    `  Recall of check findings a live room could make: ${pct(t.recall)}. Runner 🚩s pinned to their item: ${pct(t.pinning)}.`,
    `  Classifier’s attribution matches the verifier’s verdict on ${t.pairs} findings: ${pct(t.agreement)}${t.kappa === null ? ' (κ needs 30)' : `, κ = ${t.kappa.toFixed(2)}`}.`,
    `  Unlabeled: ${pct(t.unlabeled)} of ${t.labels} labels${
      Object.keys(t.why).length
        ? ` (${Object.entries(t.why)
            .map(([k, v]) => `${k} ${v}`)
            .join(', ')})`
        : ''
    }.`,
    `  Proposals: ${t.proposals}, of which ${pct(t.proposalPrecision)} of those judged were real. Classifier cost: $${t.costUsd.toFixed(3)}.`,
    ...(Object.keys(t.unverified ?? {}).length
      ? [
          `  Unverified checks: ${Object.entries(t.unverified)
            .map(([k, v]) => `${k} (${v})`)
            .join(', ')}.`,
        ]
      : []),
  ];
}
