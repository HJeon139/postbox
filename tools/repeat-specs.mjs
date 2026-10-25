// The specs CI’s ten-times job repeats (#303): those a pull request adds or edits itself. A spec it reaches only
// through a helper it changes isn’t repeated: the end-to-end job runs every spec twice already, once with the events
// late. On a later push, only the specs that push changed: the rest passed ten times on an earlier one.
//
//   node tools/repeat-specs.mjs <base> <head> [<before>]   the specs to repeat, one per line
//
// base is the branch the pull request goes into, head its newest commit, and before the head of the push before
// (GitHub’s `before`, on a synchronize), where this job passed on it. Without before, or where git doesn’t have it (a
// force push), every spec the pull request adds or edits. A spec with a name that isn’t plain exits 1.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A spec, as playwright.config.mjs finds them. Plain names only: the job passes them to a shell unquoted. @param {string} path */
export const isSpec = (path) => /^tests\/browser\/(?:[\w.-]+\/)*[\w.-]+\.spec\.mjs$/.test(path);

/**
 * The specs to repeat: those the pull request adds or edits, and of those, the ones this push changed, if it’s known.
 * @param {string[]} pr  the files the pull request adds or edits, against its base
 * @param {string[] | null} push  the files this push added or edited, or null for the first push or an unknown one
 */
export const specsToRepeat = (pr, push) => pr.filter((f) => isSpec(f) && (!push || push.includes(f))).sort();

/** The files added, edited or renamed in a range; with three dots, since the commit both sides share. */
const changed = (/** @type {string} */ range) =>
  execFileSync('git', ['diff', '--name-only', '--diff-filter=AMR', range], { encoding: 'utf8' }).split('\n').filter(Boolean);

/** Whether git has this commit: a force push leaves `before` out of the fetched history. */
const has = (/** @type {string} */ sha) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [base, head, before] = process.argv.slice(2);
  // GitHub sends forty zeros as `before` where there was no head before.
  const push = before && !/^0+$/.test(before) && has(before) ? changed(`${before}..${head}`) : null;
  const pr = changed(`${base}...${head}`);
  // A spec whose name isn’t plain fails the job, rather than going unrepeated.
  const odd = pr.filter((f) => f.startsWith('tests/browser/') && f.endsWith('.spec.mjs') && !isSpec(f));
  if (odd.length) {
    console.error(`Rename these specs to letters, digits, dots, dashes and underscores: ${odd.join(', ')}`);
    process.exit(1);
  }
  for (const f of specsToRepeat(pr, push)) console.log(f);
}
