// The command line of tools/signoff.mjs (#845). Lists stay arrays from argv to the command they reach: a spec list
// once passed as one shell word ran no tests at all, so each --spec is one argv entry, and a --spec with nothing
// after it is an error, not an empty list that runs everything.

export const USAGE = `Usage: node tools/signoff.mjs <pull request> [--run-gate [--spec <file>]… [--lock <folder>]] [--node <path>]…
  --run-gate       run npm run check and both browser runs now, under the heavy-suite lock, and write the gate log
  --spec <file>    with --run-gate, limit the browser runs to this spec file (repeatable); such a log doesn’t sign off
  --lock <folder>  with --run-gate, the lock folder to take a slot in, instead of tools/heavy-lock.mjs’s
  --node <path>    a Node binary to use for a major CI runs (repeatable)`;

/** Flags that take a value, and whether they repeat. */
const VALUED = { '--spec': 'specs', '--node': 'nodes', '--lock': 'lock' };

/**
 * The options argv gives, or the error that makes it unusable.
 * @param {string[]} argv the arguments after the script’s path
 * @returns {{ error: string } | { error?: undefined, pr: number, runGate: boolean, specs: string[], nodes: string[], lock?: string }}
 */
export function parseArgs(argv) {
  /** @type {{ pr: number, runGate: boolean, specs: string[], nodes: string[], lock?: string }} */
  const o = { pr: Number.NaN, runGate: false, specs: [], nodes: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run-gate') o.runGate = true;
    else if (Object.hasOwn(VALUED, arg)) {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) return { error: `${arg} needs a value: an empty list runs nothing it names.` };
      i++;
      const key = VALUED[/** @type {keyof VALUED} */ (arg)];
      if (key === 'lock') o.lock = value;
      else o[key].push(value);
    } else if (/^\d+$/.test(arg) && Number.isNaN(o.pr)) o.pr = Number(arg);
    else return { error: `Unknown argument: ${arg}` };
  }
  if (!Number.isInteger(o.pr) || o.pr <= 0) return { error: 'Give the pull request’s number.' };
  if ((o.specs.length || o.lock) && !o.runGate) return { error: '--spec and --lock apply only with --run-gate.' };
  return o;
}
