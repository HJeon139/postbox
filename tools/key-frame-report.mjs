// The report of PF-1’s key-to-frame tool (#508, tools/bench-key-frame.mjs): Markdown with a table per room size, each
// size’s ratio to the 1× room and its verdict against the budget, that Safari wasn’t measured, and the provenance a
// reader needs to rerun it. Pure, so tests feed it results.

import { PF1_BUDGET, withinBudget } from './key-frame-stats.mjs';

/**
 * @typedef {{ n: number, p50: number|null, p95: number|null, max: number|null }} Summary
 * @typedef {{ items: number, eventTiming: Summary, nextFrame: Summary, below: number }} SizeResult
 */

const count = (n) => n.toLocaleString('en-US');
const ms = (v) => (v === null ? 'none' : `${v.toFixed(1)} ms`);
const ratio = (r) => r.toFixed(2);
const verdict = (pass) => (pass ? 'pass' : 'fail');

/** How many times the 1× room’s size a room is, as “4×”. @param {number} items  @param {number} base */
function times(items, base) {
  return `${(items / base).toLocaleString('en-US', { maximumFractionDigits: 1 })}×`;
}

/**
 * Each size against the smallest, the 1× room: its Event Timing p95’s ratio and verdict, which decide PF-1, and its
 * next-frame p95’s ratio beside it, as a cross-check.
 * @param {SizeResult[]} results  @param {number} [budget]
 */
export function budgetRows(results, budget = PF1_BUDGET) {
  const base = [...results].sort((a, b) => a.items - b.items)[0];
  return results.map((r) => {
    const decided = withinBudget(Number(base.eventTiming.p95), Number(r.eventTiming.p95), budget);
    const check = withinBudget(Number(base.nextFrame.p95), Number(r.nextFrame.p95), budget);
    return { items: r.items, times: times(r.items, base.items), ratio: decided.ratio, pass: decided.pass, nextFrameRatio: check.ratio };
  });
}

/** The summary table: one row a size. */
function summaryTable(results, rows) {
  const lines = ['| Items | Size | Event Timing p95 | Ratio to 1× | Verdict | Next-frame p95 | Next-frame ratio |', '|---|---|---|---|---|---|---|'];
  results.forEach((r, i) => {
    const row = rows[i];
    const cells = [count(r.items), row.times, ms(r.eventTiming.p95), ratio(row.ratio), verdict(row.pass), ms(r.nextFrame.p95), ratio(row.nextFrameRatio)];
    lines.push(`| ${cells.join(' | ')} |`);
  });
  return lines;
}

/** One size’s own table: both measures’ count, p50, p95 and max. */
function sizeTable(result, row, threshold) {
  const line = (name, s) => `| ${name} | ${s.n} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.max)} |`;
  return [
    `### ${count(result.items)} items (${row.times})`,
    '',
    '| Measure | Keys | p50 | p95 | Max |',
    '|---|---|---|---|---|',
    line('Event Timing (keydown, keypress, input)', result.eventTiming),
    line('Next frame (keydown → rAF → rAF)', result.nextFrame),
    '',
    `${result.below} of ${result.eventTiming.n} keys had no Event Timing entry, so took under ${threshold} ms; each counts at ${threshold} ms.`,
    '',
  ];
}

/**
 * The whole report.
 * @param {{ command: string, commit: string, date: string, threshold?: number, budget?: number,
 *   machine: { os: string, arch: string, cpu: string, node: string, chromium: string },
 *   inputs: { sizes: number[], keys: number, warmup: number, runs: number, intervalMs: number }, results: SizeResult[] }} o
 */
export function formatReport({ command, commit, date, machine, inputs, results, threshold = 16, budget = PF1_BUDGET }) {
  const rows = budgetRows(results, budget);
  const passed = rows.every((r) => r.pass);
  return [
    '# Key-to-frame p95 by room size (PF-1, #508)',
    '',
    `PF-1 (designs/508/requirements.md): a large room’s key-to-frame p95 within ${Math.round(budget * 100)}% of the 1× room’s. PF-1: **${verdict(passed)}**.`,
    '',
    'A report run by hand with `tools/bench-key-frame.mjs`; not a CI gate. Event Timing decides the p95; the next-frame timer is a cross-check.',
    '',
    'Safari: not measured. This sprint measures Chromium only, so Safari’s idle painting is not part of this report.',
    '',
    '## Summary',
    '',
    ...summaryTable(results, rows),
    '',
    '## By size',
    '',
    ...results.flatMap((r, i) => sizeTable(r, rows[i], threshold)),
    '## Provenance',
    '',
    `- Command: \`${command}\``,
    `- Inputs: rooms of ${inputs.sizes.map(count).join(', ')} items from the big-room seed (tools/uat/big-room.mjs); ${inputs.keys} keys after ${inputs.warmup} warm-up keys, one every ${inputs.intervalMs} ms; ${inputs.runs} runs a size`,
    `- Event Timing: PerformanceObserver type “event”, durationThreshold ${threshold}, the composer’s keydown, keypress and input entries`,
    `- Commit: ${commit}`,
    `- Date: ${date}`,
    `- Machine: ${machine.os}, ${machine.arch}, ${machine.cpu}; Node ${machine.node}; Chromium ${machine.chromium}`,
    '',
  ].join('\n');
}
