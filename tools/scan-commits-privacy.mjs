// Checks the lines each commit of a range adds for private data, with the same checker the tree’s privacy test uses
// (tools/privacy-check.mjs, checkFilePrivacy). The tree check sees only the last commit’s files, so a home path added in
// one commit and removed in a later one passes it, yet stays in the history a merge keeps (#508). CI runs this on a
// pull request’s commits, after the commit-message check.
//
//   node tools/scan-commits-privacy.mjs origin/main..HEAD
//
// It reads each commit’s diff without context (`git show -U0`), so its cost is O(lines added and removed in the range),
// never the size of the tree. Binary files and the checker’s own example files aren’t checked. Merge commits are left
// out, as tools/lint-commits.mjs leaves them out: the lines a merge brings in are checked in the commits that added them.
//
// Exit codes: 0 when nothing private was added, 1 when something was, and 2 when the range or a diff can’t be read.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseAddedLines } from './diff-added-lines.mjs';
import { checkFilePrivacy } from './privacy-check.mjs';

/**
 * @typedef {{ sha: string, path: string, violation: string }} Finding
 * @typedef {{ commits: (range: string) => string[], show: (sha: string) => string }} GitReader
 */

/**
 * Checks the lines each commit of a range adds, oldest first. A commit’s lines are checked as that commit added them,
 * so a later commit that removes them doesn’t clear them.
 *
 * @param {string} range
 * @param {GitReader} git
 * @returns {{ commits: number, files: number, lines: number, binary: number, findings: Finding[] }}
 */
export function scanCommits(range, git) {
  const result = { commits: 0, files: 0, lines: 0, binary: 0, findings: /** @type {Finding[]} */ ([]) };
  for (const sha of git.commits(range)) {
    result.commits++;
    let parsed;
    try {
      parsed = parseAddedLines(git.show(sha));
    } catch (error) {
      throw new Error(`commit ${sha.slice(0, 7)}: ${/** @type {Error} */ (error).message}`);
    }
    result.binary += parsed.binary;
    for (const [path, added] of parsed.files) {
      result.files++;
      result.lines += added.length;
      for (const violation of checkFilePrivacy(path, added.join('\n'))) result.findings.push({ sha, path, violation });
    }
  }
  return result;
}

/** One finding as the tool reports it: “<short sha> <path>: <violation>”. @param {Finding} finding */
export function formatFinding({ sha, path, violation }) {
  return `${sha.slice(0, 7)} ${path}: ${violation}`;
}

/** A count and its noun, plural unless the count is one. @param {number} n @param {string} noun */
function count(n, noun) {
  if (n === 1) return `${n} ${noun}`;
  return `${n} ${noun}s`;
}

/** The commits of a range and their diffs, from real git in the current folder. @returns {GitReader} */
function realGit() {
  const options = { encoding: /** @type {const} */ ('utf8'), maxBuffer: 512 * 1024 * 1024 };
  return {
    commits(range) {
      let out;
      try {
        out = execFileSync('git', ['rev-list', '--reverse', '--no-merges', '--end-of-options', range], { ...options, stdio: 'pipe' });
      } catch (error) {
        const said = String(/** @type {{ stderr?: string }} */ (error).stderr ?? '').trim();
        throw new Error(`can’t list the commits in ${range}. Fetch the base first, or check the range. git said: ${said}`);
      }
      return out.split('\n').filter(Boolean);
    },
    // The prefixes, renames, colors and text conversion are set here, so the person’s own git config can’t change
    // the shape this reads.
    show: (sha) =>
      execFileSync(
        'git',
        ['show', '--format=', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/', sha],
        options,
      ),
  };
}

/** Runs the scan over the range in argv, prints what it found, and returns the exit code. @param {string[]} args */
function main(args) {
  const range = args[0];
  if (!range || args.length > 1) {
    console.error('Usage: node tools/scan-commits-privacy.mjs RANGE, such as origin/main..HEAD');
    return 2;
  }
  let result;
  try {
    result = scanCommits(range, realGit());
  } catch (error) {
    console.error(`scan-commits-privacy: ${/** @type {Error} */ (error).message}`);
    return 2;
  }
  if (result.commits === 0) {
    console.log(`scan-commits-privacy: no commits in ${range}, so nothing to check.`);
    return 0;
  }
  const skipped = result.binary > 0 ? `; ${count(result.binary, 'binary file')} skipped` : '';
  if (result.findings.length === 0) {
    const read = `${count(result.commits, 'commit')} added ${count(result.lines, 'line')} in ${count(result.files, 'file')}`;
    console.log(`scan-commits-privacy: ${read}, none of them private${skipped}.`);
    return 0;
  }
  for (const finding of result.findings) console.error(formatFinding(finding));
  console.error(
    `\n${count(result.findings.length, 'private string')} added in ${range}. A later commit that removes one leaves it in the history: rewrite the commit that adds it.`,
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
