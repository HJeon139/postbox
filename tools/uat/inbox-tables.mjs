// The tables tools/uat/inbox-measures.mjs prints: each measure across one side’s runs, as a mean with its range.

/** The mean of some numbers, or null of none. */
const mean = (/** @type {number[]} */ xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** What each measure is called, and what passes, as the design’s table has them. */
const ROWS = [
  ['crossed', 'Messages crossed', 'fewer than main'],
  ['idleWakes', 'Wakes that found nothing to do', 'no more than main'],
  ['doubledHandOffs', 'A hand-off posted twice', 'none'],
  ['copyWakes', 'Wakes by a copied line', 'none'],
  ['requestsPerTurn', 'Model requests per turn', 'no more than main'],
  ['readsAfterWake', 'Reads after a wake, per woken turn', 'fewer than main'],
  ['promptTokensPerTurn', 'Postbox’s input per turn, Claude Code, tokens', 'no more than main'],
  ['inputTokensPerTurn', 'Input tokens per turn, as reported', 'reported'],
  ['waitingElsewhere', 'Entries waiting in another thread at a turn’s start', 'reported'],
];

/**
 * A measure across one side’s runs: its mean and range, or “not recorded” when no run has it.
 * @param {any[]} runs @param {string} key
 */
export function across(runs, key) {
  const values = runs.map((r) => r[key]).filter((v) => v !== null);
  if (!values.length) return 'not recorded';
  const round = (/** @type {number} */ n) => {
    if (Math.abs(n) >= 100) return Math.round(n).toLocaleString('en-US');
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  };
  const range = values.length > 1 ? ` (${round(Math.min(...values))} to ${round(Math.max(...values))})` : '';
  return `${round(/** @type {number} */ (mean(values)))}${range}`;
}

/** The table for two sides’ runs, as Markdown. */
export function table(/** @type {any[]} */ main, /** @type {any[]} */ branch) {
  const head = `| Measure | main, ${main.length} ${main.length === 1 ? 'run' : 'runs'} | branch, ${branch.length} ${branch.length === 1 ? 'run' : 'runs'} | What passes |\n|---|---|---|---|`;
  return [head, ...ROWS.map(([key, name, passes]) => `| ${name} | ${across(main, key)} | ${across(branch, key)} | ${passes} |`)].join('\n');
}

/** What the table by harness gives for each harness, per run. */
const HARNESS_ROWS = [
  ['input', 'Input tokens'],
  ['requests', 'Model requests'],
  ['toolCalls', 'Tool calls'],
  ['turns', 'Turns'],
];

/**
 * One side’s runs for one harness and one figure: “not recorded” when no run had that harness, “not reported” when
 * the harness reports none.
 * @param {any[]} runs @param {string} harness @param {string} key
 */
function acrossHarness(runs, harness, key) {
  const had = runs.map((r) => r.harnesses?.[harness]).filter(Boolean);
  if (!had.length) return 'not recorded';
  const text = across(had, key);
  return text === 'not recorded' ? 'not reported' : text;
}

/**
 * The table by harness for two sides’ runs, as Markdown: each harness’s figures per run, so a change on one harness
 * isn’t hidden in a mean over all of them.
 * @param {any[]} main @param {any[]} branch
 */
export function harnessTable(main, branch) {
  const runs = (/** @type {any[]} */ side) => `${side.length} ${side.length === 1 ? 'run' : 'runs'}`;
  const names = [...new Set([...main, ...branch].flatMap((r) => Object.keys(r.harnesses ?? {})))];
  const rows = names.flatMap((h) =>
    HARNESS_ROWS.map(([key, name]) => `| ${h} | ${name} | ${acrossHarness(main, h, key)} | ${acrossHarness(branch, h, key)} |`),
  );
  return [`| Harness | Per run | main, ${runs(main)} | branch, ${runs(branch)} |`, '|---|---|---|---|', ...rows].join('\n');
}
