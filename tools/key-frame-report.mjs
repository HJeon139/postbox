// The report of PF-1’s key-to-frame tool (#508, tools/bench-key-frame.mjs): Markdown with a table per room size, each
// size’s ratio to the 1× room and its verdict against the budget, that Safari wasn’t measured, and the provenance a
// reader needs to rerun it. Pure, so tests feed it results.

import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { enoughEntries, MAX_MISSING_SHARE, PF1_BUDGET, withinBudget } from './key-frame-stats.mjs';

/**
 * @typedef {{ n: number, p50: number|null, p95: number|null, max: number|null }} Summary
 * @typedef {{ items: number, eventTiming: Summary, nextFrame: Summary, below: number }} SizeResult
 */

/**
 * A path as a report shows it: relative to the repo when it’s inside it, else just its file name, so a report never
 * names a folder of the machine it ran on.
 * @param {string} path  @param {string} root  the repo’s folder
 */
export function shownPath(path, root) {
  const inRepo = relative(root, resolve(path));
  const outside = inRepo === '' || inRepo === '..' || inRepo.startsWith(`..${sep}`) || isAbsolute(inRepo);
  return outside ? basename(path) : inRepo;
}

const count = (n) => n.toLocaleString('en-US');
const ms = (v) => (v === null ? 'none' : `${v.toFixed(1)} ms`);
const ratio = (r) => r.toFixed(2);
const verdict = (pass) => (pass ? 'pass' : 'fail');
const NOT_MEASURED = 'not measured';

/** How many times the 1× room’s size a room is, as “4×”. @param {number} items  @param {number} base */
function times(items, base) {
  return `${(items / base).toLocaleString('en-US', { maximumFractionDigits: 1 })}×`;
}

/** Whether a size had enough Event Timing entries for its p95 to be a measurement. @param {SizeResult} r */
const measured = (r) => enoughEntries(r.below, r.eventTiming.n);

/**
 * Each size against the smallest, the 1× room: its Event Timing p95’s ratio and verdict, which decide PF-1, and its
 * next-frame p95’s ratio beside it, as a cross-check. A size, or a 1× room, with too many keys missing an entry is
 * “not measured”: its p95 is the threshold it was filled with.
 * @param {SizeResult[]} results  @param {number} [budget]
 */
export function budgetRows(results, budget = PF1_BUDGET) {
  const base = [...results].sort((a, b) => a.items - b.items)[0];
  return results.map((r) => {
    const decided = withinBudget(Number(base.eventTiming.p95), Number(r.eventTiming.p95), budget);
    const check = withinBudget(Number(base.nextFrame.p95), Number(r.nextFrame.p95), budget);
    const judged = measured(base) && measured(r);
    const shown = judged ? verdict(decided.pass) : NOT_MEASURED;
    return {
      items: r.items,
      times: times(r.items, base.items),
      ratio: decided.ratio,
      pass: judged && decided.pass,
      verdict: shown,
      nextFrameRatio: check.ratio,
    };
  });
}

/** PF-1’s verdict over every size: not measured when one isn’t, else pass only when every size passes. */
function overall(rows) {
  if (rows.some((r) => r.verdict === NOT_MEASURED)) return NOT_MEASURED;
  return verdict(rows.every((r) => r.pass));
}

/** The summary table: one row a size. */
function summaryTable(results, rows) {
  const lines = ['| Items | Size | Event Timing p95 | Ratio to 1× | Verdict | Next-frame p95 | Next-frame ratio |', '|---|---|---|---|---|---|---|'];
  results.forEach((r, i) => {
    const row = rows[i];
    const cells = [count(r.items), row.times, ms(r.eventTiming.p95), ratio(row.ratio), row.verdict, ms(r.nextFrame.p95), ratio(row.nextFrameRatio)];
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
    belowLine(result.below, result.eventTiming.n, threshold),
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
  return [
    '# Key-to-frame p95 by room size (PF-1, #508)',
    '',
    `PF-1 (designs/508/requirements.md): a large room’s key-to-frame p95 within ${Math.round(budget * 100)}% of the 1× room’s. PF-1: **${overall(rows)}**.`,
    '',
    'A report run by hand with `tools/bench-key-frame.mjs`; not a CI gate. Event Timing decides the p95; the next-frame timer is a cross-check.',
    '',
    'Safari: not measured. This sprint measures Chromium only, so Safari’s idle painting is not part of this report.',
    '',
    '## Summary',
    '',
    ...summaryTable(results, rows),
    '',
    `Event Timing reports durations in 8 ms steps, so near a 1× p95 of 24 ms the ${Math.round(budget * 100)}% budget is finer than one step, which is why the next-frame timer is shown.`,
    '',
    '## By size',
    '',
    ...results.flatMap((r, i) => sizeTable(r, rows[i], threshold)),
    '## Provenance',
    '',
    `- Command: \`${command}\``,
    `- Inputs: rooms of ${inputs.sizes.map(count).join(', ')} items from the big-room seed (tools/uat/big-room.mjs); ${inputs.keys} keys after ${inputs.warmup} warm-up keys, one every ${inputs.intervalMs} ms; ${inputs.runs} run${inputs.runs === 1 ? '' : 's'} a size`,
    `- Event Timing: PerformanceObserver type “event”, durationThreshold ${threshold}, the composer’s keydown, keypress and input entries`,
    `- Commit: ${commit}`,
    `- Date: ${date}`,
    `- Machine: ${machine.os}, ${machine.arch}, ${machine.cpu}; Node ${machine.node}; Chromium ${machine.chromium}`,
    '',
  ].join('\n');
}

/**
 * How many keys had no Event Timing entry, which Chromium leaves out below its threshold.
 * @param {number} below @param {number} keys @param {number} threshold  in ms
 */
export function belowLine(below, keys, threshold) {
  if (below === 0) return 'Every key had an Event Timing entry.';
  const counted = `${below} of ${keys} keys had no Event Timing entry, so took under ${threshold} ms; each counts at ${threshold} ms.`;
  if (enoughEntries(below, keys)) return counted;
  return `${counted} That is over ${Math.round(MAX_MISSING_SHARE * 100)}% of them, so this size is not measured.`;
}
