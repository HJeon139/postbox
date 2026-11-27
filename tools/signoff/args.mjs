// The command line of tools/signoff.mjs (#845). Lists stay arrays from argv to the command they reach: a spec list
// once passed as one shell word ran no tests at all, so each --node is one argv entry, and a --node with nothing
// after it is an error, not an empty list.

export const USAGE = `Usage: node tools/signoff.mjs <pull request> [--node <path>]…
  --node <path>    a Node binary to use for a major CI runs (repeatable)`;

/**
 * The options argv gives, or the error that makes it unusable.
 * @param {string[]} argv the arguments after the script’s path
 * @returns {{ error: string } | { error?: undefined, pr: number, nodes: string[] }}
 */
export function parseArgs(argv) {
  /** @type {{ pr: number, nodes: string[] }} */
  const o = { pr: Number.NaN, nodes: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--node') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) return { error: `${arg} needs a value: an empty list runs nothing it names.` };
      i++;
      o.nodes.push(value);
    } else if (/^\d+$/.test(arg) && Number.isNaN(o.pr)) o.pr = Number(arg);
    else return { error: `Unknown argument: ${arg}` };
  }
  if (!Number.isInteger(o.pr) || o.pr <= 0) return { error: 'Give the pull request’s number.' };
  return o;
}
