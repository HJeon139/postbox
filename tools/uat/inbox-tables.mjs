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
