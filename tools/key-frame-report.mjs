// The report of PF-1’s key-to-frame tool (#508, tools/bench-key-frame.mjs): Markdown with a table per room size, each
// size’s ratio to the 1× room and its verdict against the budget, that Safari wasn’t measured, and the provenance a
// reader needs to rerun it. Pure, so tests feed it results.

import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { PF1_BUDGET, underOneFrame, withinBudget } from './key-frame-stats.mjs';

/**
 * @typedef {{ n: number, p50: number|null, p95: number|null, max: number|null }} Summary
 * @typedef {{ items: number, eventTiming: Summary, nextFrame: Summary, below: number }} SizeResult
 * @typedef {{ load: { start: number, end: number }, headless: boolean, window: { width: number, height: number },
 *   scale: number }} Conditions
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
/** An Event Timing time, which at the threshold or under is a bound: “≤ 16 ms”. */
const eventMs = (v, threshold) => (underOneFrame(v, threshold) ? `≤ ${threshold} ms` : ms(v));
const ratio = (r) => r.toFixed(2);
const verdict = (pass) => (pass ? 'pass' : 'fail');
const NOT_MEASURED = 'not measured';

/** How many times the 1× room’s size a room is, as “4×”. @param {number} items  @param {number} base */
function times(items, base) {
  return `${(items / base).toLocaleString('en-US', { maximumFractionDigits: 1 })}×`;
}

/** Whether a size measured any key: one with none has no p95 to judge. @param {SizeResult} r */
const measured = (r) => r.eventTiming.n > 0;

/**
 * Each size against the smallest, the 1× room: its Event Timing p95’s ratio and verdict, which decide PF-1, and its
 * next-frame p95’s ratio beside it, as a cross-check. A size, or a 1× room, that measured no key is “not measured”.
 * A 1× room under one frame counts at the threshold (underOneFrame()).
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
function summaryTable(results, rows, threshold) {
  const lines = ['| Items | Size | Event Timing p95 | Ratio to 1× | Verdict | Next-frame p95 | Next-frame ratio |', '|---|---|---|---|---|---|---|'];
  results.forEach((r, i) => {
    const row = rows[i];
    const cells = [
      count(r.items),
      row.times,
      eventMs(r.eventTiming.p95, threshold),
      ratio(row.ratio),
      row.verdict,
      ms(r.nextFrame.p95),
      ratio(row.nextFrameRatio),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  });
  return lines;
}

/** One size’s own table: both measures’ count, p50, p95 and max. */
function sizeTable(result, row, threshold) {
  const line = (name, s, shown = ms) => `| ${name} | ${s.n} | ${shown(s.p50)} | ${shown(s.p95)} | ${shown(s.max)} |`;
  return [
    `### ${count(result.items)} items (${row.times})`,
    '',
    '| Measure | Keys | p50 | p95 | Max |',
    '|---|---|---|---|---|',
    line('Event Timing (keydown, keypress, input)', result.eventTiming, (v) => eventMs(v, threshold)),
    line('Next frame (keydown → rAF → rAF)', result.nextFrame),
    '',
    belowLine(result.below, result.eventTiming.n, threshold),
    '',
  ];
}

/**
 * The whole report.
 * @param {{ command: string, commit: string, date: string, threshold?: number, budget?: number,
 *   machine: { os: string, arch: string, cpu: string, node: string, chromium: string }, conditions: Conditions,
 *   inputs: { sizes: number[], keys: number, warmup: number, runs: number, intervalMs: number }, results: SizeResult[] }} o
 */
export function formatReport({ command, commit, date, machine, conditions, inputs, results, threshold = 16, budget = PF1_BUDGET }) {
  const rows = budgetRows(results, budget);
  return [
    '# Key-to-frame p95 by room size (PF-1, #508)',
    '',
    `PF-1 (designs/508/requirements.md): a large room’s key-to-frame p95 within ${Math.round(budget * 100)}% of the 1× room’s. PF-1: **${overall(rows)}**.`,
    '',
    `Event Timing leaves out keys under ${threshold} ms, one frame, so a p95 of ${threshold} ms or less is a bound: a 1× room under one frame counts at ${threshold} ms, and a larger room passes at up to ${(threshold * (1 + budget)).toFixed(1)} ms.`,
    '',
    'A report run by hand with `tools/bench-key-frame.mjs`; not a CI gate. Event Timing decides the p95; the next-frame timer is a cross-check.',
    '',
    'Safari: not measured. This sprint measures Chromium only, so Safari’s idle painting is not part of this report.',
    '',
    '## Summary',
    '',
    ...summaryTable(results, rows, threshold),
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
    `- Conditions: ${conditionsLine(conditions)}`,
    '',
  ].join('\n');
}

/**
 * How many keys had no Event Timing entry, which Chromium leaves out below its threshold.
 * @param {number} below @param {number} keys @param {number} threshold  in ms
 */
export function belowLine(below, keys, threshold) {
  if (below === 0) return 'Every key had an Event Timing entry.';
  return `${below} of ${keys} keys had no Event Timing entry, so took under ${threshold} ms; each counts at ${threshold} ms.`;
}

/**
 * The conditions behind the numbers, as one line: the load average at the start and the end, headless or not, and
 * the window’s size at its device scale. @param {Conditions} c
 */
export function conditionsLine(c) {
  const load = `load average ${c.load.start.toFixed(2)} at the start and ${c.load.end.toFixed(2)} at the end`;
  const mode = c.headless ? 'headless' : 'not headless';
  return `${load}; ${mode}; window ${c.window.width}×${c.window.height} at device scale ${c.scale}`;
}
