// The specs CI’s ten-times job repeats (#303): those a pull request adds or edits itself. A spec it reaches only
// through a helper it changes isn’t repeated: the end-to-end job runs every spec twice already, once with the events
// late. On a later push, only the specs that push changed, or that it brought into the pull request: the rest passed
// ten times on an earlier push.
//
//   node tools/repeat-specs.mjs <base> <head> [<before>]   the specs to repeat, one per line
//
// base is the branch the pull request goes into, head its newest commit, and before the head of the push before
// (GitHub’s `before`, on a synchronize), which the job passes only where it passed on it. Without before, or where git
// doesn’t have it, every spec the pull request adds or edits. A spec with a name that isn’t plain exits 1.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A spec, as playwright.config.mjs finds them. Plain names only: the job passes them to a shell unquoted. @param {string} path */
export const isSpec = (path) => /^tests\/browser\/(?:[\w.-]+\/)*[\w.-]+\.spec\.mjs$/.test(path);

/**
 * The specs to repeat: those the pull request adds or edits, and where the push before passed, only those this push
 * changed or that weren’t in the pull request then (a retarget to another base, a merge that brings one in).
 * @param {string[]} pr  the files the pull request adds or edits, against its base
 * @param {{ push: string[], pr: string[] } | null} before  the files this push changed, and the pull request’s files
 *   at the push before; null for the first push, or where the push before can’t be trusted
 */
export const specsToRepeat = (pr, before) => pr.filter((f) => isSpec(f) && (!before || before.push.includes(f) || !before.pr.includes(f))).sort();

/** The files added, edited or renamed in a range; with three dots, since the commit both sides share. */
const changed = (/** @type {string} */ range) =>
  execFileSync('git', ['diff', '--name-only', '--diff-filter=AMR', range], { encoding: 'utf8' }).split('\n').filter(Boolean);

/** Whether git has this commit: a force push can leave `before` out of the fetched history. */
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
  const pr = changed(`${base}...${head}`);
  // A spec whose name isn’t plain fails the job, rather than going unrepeated.
  const odd = pr.filter((f) => f.startsWith('tests/browser/') && f.endsWith('.spec.mjs') && !isSpec(f));
  if (odd.length) {
    console.error(`Rename these specs to letters, digits, dots, dashes and underscores: ${odd.join(', ')}`);
    process.exit(1);
  }
  // GitHub sends forty zeros as `before` where there was no head before.
  const was = before && !/^0+$/.test(before) && has(before) ? { push: changed(`${before}..${head}`), pr: changed(`${base}...${before}`) } : null;
  for (const f of specsToRepeat(pr, was)) console.log(f);
}
