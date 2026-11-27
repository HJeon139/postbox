// The command line of tools/signoff.mjs (#845): the pull request’s number, and nothing else. Anything more is an error
// rather than ignored, so a flag from an older version of the script doesn’t pass without a word.

export const USAGE = 'Usage: node tools/signoff.mjs <pull request>';

/**
 * The options argv gives, or the error that makes it unusable.
 * @param {string[]} argv the arguments after the script’s path
 * @returns {{ error: string } | { error?: undefined, pr: number }}
 */
export function parseArgs(argv) {
  let pr = Number.NaN;
  for (const arg of argv) {
    if (/^\d+$/.test(arg) && Number.isNaN(pr)) pr = Number(arg);
    else return { error: `Unknown argument: ${arg}` };
  }
  if (!Number.isInteger(pr) || pr <= 0) return { error: 'Give the pull request’s number.' };
  return { pr };
}
