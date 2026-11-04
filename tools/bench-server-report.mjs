// The report of the server bench (#508, tools/bench-server.mjs): Markdown with a table for each of its four numbers,
// a row a room size, and the provenance a reader needs to rerun it. Pure, so tests feed it results.

import { DEFAULT_STALL_BUDGET_MS } from './bench-snapshot-stall.mjs';

/**
 * @typedef {{ n: number, p50: number|null, p95: number|null, max: number|null }} Summary
 * @typedef {{ items: number, snapshotMB: number, stringify: Summary, stall: Summary, api: Summary, apiBytes: number,
 *   chunk: Summary, startup: Summary, logEvents: number }} SizeResult
 */

const count = (n) => n.toLocaleString('en-US');

/** A time in ms, to a tenth. @param {number|null} v */
function ms(v) {
  if (v === null) return 'none';
  return `${v.toFixed(1)} ms`;
}

/** A time given in ms, shown in µs, to a tenth: a streamed chunk takes microseconds. @param {number|null} v */
function us(v) {
  if (v === null) return 'none';
  return `${(v * 1000).toFixed(1)} µs`;
}

/** How many times the smallest room a room is, as “4×”. @param {number} items  @param {number} base */
function times(items, base) {
  return `${(items / base).toLocaleString('en-US', { maximumFractionDigits: 1 })}×`;
}

/** A Markdown table: a header, and a row of cells a result. @param {string[]} head  @param {string[][]} rows */
function table(head, rows) {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((cells) => `| ${cells.join(' | ')} |`)];
}

/** Whether a size’s worst stall is under the budget, as the snapshot bench decides it (stallMs >= budget exceeds). */
function stallVerdict(stall) {
  if (stall.max === null) return 'none';
  return stall.max < DEFAULT_STALL_BUDGET_MS ? 'pass' : 'fail';
}

/** The four tables, each with a row a size. @param {SizeResult[]} results */
function tables(results) {
  const base = Math.min(...results.map((r) => r.items));
  const lead = (r) => [count(r.items), times(r.items, base)];
  const spread = (s, show) => [show(s.p50), show(s.p95), show(s.max)];
  return [
    '## Snapshot stall',
    '',
    `The longest of \`JSON.stringify\` of the state and the event loop’s delay while the server’s \`writeSnapshot()\` runs (tools/bench-snapshot-stall.mjs), one a run. Budget: under ${DEFAULT_STALL_BUDGET_MS} ms at the worst run.`,
    '',
    ...table(
      ['Items', 'Size', 'Snapshot', 'Stringify p50', 'Stall p50', 'Stall p95', 'Stall max', 'Verdict'],
      results.map((r) => [...lead(r), `${r.snapshotMB.toFixed(2)} MB`, ms(r.stringify.p50), ...spread(r.stall, ms), stallVerdict(r.stall)]),
    ),
    '',
    '## `/api/state`',
    '',
    'Each request’s time, from the request to the whole body read, on a Postbox started on the room; and the body’s bytes.',
    '',
    ...table(
      ['Items', 'Size', 'Bytes', 'p50', 'p95', 'Max'],
      results.map((r) => [...lead(r), count(r.apiBytes), ...spread(r.api, ms)]),
    ),
    '',
    '## Streamed reply',
    '',
    'Each `item.text` chunk through the shared reducer (shared/state.mjs), for a reply added at the end of the thread.',
    '',
    ...table(
      ['Items', 'Size', 'p50', 'p95', 'Max'],
      results.map((r) => [...lead(r), ...spread(r.chunk, us)]),
    ),
    '',
    '## Startup',
    '',
    'The server’s `Store.load()` of the room’s snapshot and a log after it as long as the store lets one grow before it snapshots, one a run.',
    '',
    ...table(
      ['Items', 'Size', 'Log events', 'p50', 'p95', 'Max'],
      results.map((r) => [...lead(r), count(r.logEvents), ...spread(r.startup, ms)]),
    ),
    '',
  ];
}

/**
 * The whole report.
 * @param {{ command: string, commit: string, date: string, machine: { os: string, arch: string, cpu: string, node: string },
 *   inputs: { sizes: number[], runs: number, requests: number, chunks: number }, results: SizeResult[] }} o
 */
export function formatServerReport({ command, commit, date, machine, inputs, results }) {
  const runs = `${inputs.runs} run${inputs.runs === 1 ? '' : 's'} a size`;
  return [
    '# The server’s numbers by room size (#508)',
    '',
    'A report run by hand with `tools/bench-server.mjs`; not a CI gate. Percentiles are by nearest rank over every run’s values pooled (tools/key-frame-stats.mjs).',
    '',
    ...tables(results),
    '## Provenance',
    '',
    `- Command: \`${command}\``,
    `- Inputs: rooms of ${inputs.sizes.map(count).join(', ')} items from the big-room seed (tools/uat/big-room.mjs); ${runs}; ${inputs.requests} requests a run; ${inputs.chunks} chunks a run`,
    `- Commit: ${commit}`,
    `- Date: ${date}`,
    `- Machine: ${machine.os}, ${machine.arch}, ${machine.cpu}; Node ${machine.node}`,
    '',
  ].join('\n');
}
