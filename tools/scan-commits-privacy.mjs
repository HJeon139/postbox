// Checks the lines each commit of a range adds for private data, with the same checker the tree’s privacy test uses
// (tools/privacy-check.mjs, checkFilePrivacy). The tree check sees only the last commit’s files, so a home path added in
// one commit and removed in a later one passes it, yet stays in the history a merge keeps (#508). CI runs this on a
// pull request’s commits, after the commit-message check.
//
//   node tools/scan-commits-privacy.mjs origin/main..HEAD
//
// It reads each commit’s diff without context (`git show -U0`), so its cost is O(lines added and removed in the range),
// never the size of the tree. Merge commits are read too, CI’s own among them (a pull request’s HEAD is a merge), with
// `git show --remerge-diff`: that shows only what the merge itself adds beyond the merge git would have made, such as a
// conflict’s resolution or a file added before the merge was committed, as the lines it brings in are checked in the
// commits that added them. A file whose added lines hold a zero byte is binary, as git decides it, and isn’t checked;
// .gitattributes can’t hide a text file, as the diff is asked for as text. The checker’s own files are checked too.
//
// Each file a commit adds lines to is checked by its name as well, a binary file’s too, as a name is published as
// surely as what the file holds (#785). A file added empty, or renamed with no line changed, adds no line, so its name
// is left to the tree’s privacy test (tests/process/privacy-tree.test.mjs), which reads every tracked file’s name.
//
// Each commit’s message, subject, body and trailers, is checked with the same checker. Its author and committer names
// and emails aren’t: each commit’s author is a real person’s GitHub identity, by design.
//
// Exit codes: 0 when nothing private was added, 1 when something was, and 2 when the range or a diff can’t be read, or
// git is older than 2.36.

import { execFileSync } from 'node:child_process';
import { DIFF_OPTIONS, parseAddedLines } from './diff-added-lines.mjs';
import { isEntry } from './lint-lib.mjs';
import { checkContentPrivacy, checkFilePrivacy, checkPathPrivacy, inFileName, isBinary } from './privacy-check.mjs';

/**
 * A private string, and where it was added: a commit’s file, or its message when the path is null.
 * @typedef {{ sha: string, path: string | null, violation: string }} Finding
 * @typedef {{ commits: (range: string) => string[], show: (sha: string) => string, message: (sha: string) => string }} GitReader
 */

/**
 * Checks each commit of a range, oldest first: its message, and the lines it adds. A commit’s lines are checked as that
 * commit added them, so a later commit that removes them doesn’t clear them.
 *
 * @param {string} range
 * @param {GitReader} git
 * @returns {{ commits: number, files: number, lines: number, binary: number, findings: Finding[] }}
 */
export function scanCommits(range, git) {
  const result = { commits: 0, files: 0, lines: 0, binary: 0, findings: /** @type {Finding[]} */ ([]) };
  for (const sha of git.commits(range)) {
    result.commits++;
    for (const violation of checkContentPrivacy(git.message(sha))) result.findings.push({ sha, path: null, violation });
    let parsed;
    try {
      parsed = parseAddedLines(git.show(sha));
    } catch (error) {
      throw new Error(`commit ${sha.slice(0, 7)}: ${/** @type {Error} */ (error).message}`);
    }
    result.binary += parsed.binary;
    for (const [path, added] of parsed.files) {
      for (const violation of checkPathPrivacy(path)) result.findings.push({ sha, path, violation });
      if (isBinary(Buffer.from(added.join('\n')))) {
        result.binary++;
        continue;
      }
      result.files++;
      result.lines += added.length;
      const lineOf = newFileLine(parsed.ranges.get(path) ?? []);
      for (const violation of checkFilePrivacy(path, added.join('\n'), lineOf)) result.findings.push({ sha, path, violation });
    }
  }
  return result;
}

/**
 * The line in the new file of each line a commit adds, counted from 1 in the order the diff adds them, so a finding
 * names the file’s own line. A line past the ranges, which a diff git wrote can’t have, is named as it is.
 * @param {{ start: number, end: number }[]} ranges
 * @returns {(line: number) => number}
 */
function newFileLine(ranges) {
  const lines = ranges.flatMap(({ start, end }) => Array.from({ length: end - start + 1 }, (_, i) => start + i));
  return (line) => lines[line - 1] ?? line;
}

/**
 * One finding as the tool reports it: “<short sha> <path>: <violation>”, or “<short sha> message: …”. A finding in a
 * file’s name prints “a file’s name” in place of the path, as the name may be what’s private (#784); `git show --stat`
 * on the commit lists its files.
 * @param {Finding} finding
 */
export function formatFinding({ sha, path, violation }) {
  let where = path ?? 'message';
  if (inFileName(violation)) where = 'a file’s name';
  return `${sha.slice(0, 7)} ${where}: ${violation}`;
}

/** A count and its noun, plural unless the count is one. @param {number} n @param {string} noun */
function count(n, noun) {
  if (n === 1) return `${n} ${noun}`;
  return `${n} ${noun}s`;
}

/**
 * A commit’s message, from what `git cat-file commit` prints: after its header lines, which end at the first empty line,
 * and hold its author and committer. A commit with no message has nothing after them.
 * @param {string} raw
 */
function commitMessage(raw) {
  const end = raw.indexOf('\n\n');
  if (end === -1) return '';
  return raw.slice(end + 2);
}

// The diff options that fix the shape this reads (DIFF_OPTIONS), and, for `git show`: no commit header; binary files
// as text, whatever .gitattributes says, as scanCommits decides what’s binary; and a merge as what it adds beyond the
// automatic merge.
const SHOW_OPTIONS = ['--format=', ...DIFF_OPTIONS, '--text', '--remerge-diff'];

// The oldest git whose `git show` has --remerge-diff (git 2.36’s release notes).
const MIN_GIT = [2, 36, 0];

// The version `git --version` prints, such as “git version 2.39.3 (Apple Git-145)” or “git version 2.45.1.windows.1”:
// its first three numbers, and nothing a vendor adds after them.
const GIT_VERSION = /^git version (\d+)\.(\d+)(?:\.(\d+))?/;

/**
 * Why this git can’t run the scan, or null when it can.
 * @param {string} output what `git --version` printed
 * @returns {string | null}
 */
export function gitVersionProblem(output) {
  const match = GIT_VERSION.exec(output.trim());
  if (!match) return `can’t read git’s version from “${output.trim()}”. The scan needs git ${MIN_GIT.join('.')} or later.`;
  const version = [match[1], match[2], match[3] ?? '0'].map(Number);
  const older = version.findIndex((part, i) => part !== MIN_GIT[i]);
  if (older === -1 || version[older] > MIN_GIT[older]) return null;
  return `git ${version.join('.')} is too old: the scan needs git ${MIN_GIT.join('.')} or later, for --remerge-diff.`;
}

/**
 * The commits of a range, their diffs and their messages, from real git, run at the top of the repository the current
 * folder is in.
 * @returns {GitReader}
 */
function realGit() {
  const options = { encoding: /** @type {const} */ ('utf8'), maxBuffer: 512 * 1024 * 1024, stdio: /** @type {const} */ ('pipe') };
  let top;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], options).trim();
  } catch (error) {
    throw new Error(`can’t find the repository. git said: ${String(/** @type {{ stderr?: string }} */ (error).stderr ?? '').trim()}`);
  }
  const atTop = { ...options, cwd: top };
  return {
    commits(range) {
      let out;
      try {
        out = execFileSync('git', ['rev-list', '--reverse', '--end-of-options', range], atTop);
      } catch (error) {
        const said = String(/** @type {{ stderr?: string }} */ (error).stderr ?? '').trim();
        throw new Error(`can’t list the commits in ${range}. Fetch the base first, or check the range. git said: ${said}`);
      }
      return out.split('\n').filter(Boolean);
    },
    show: (sha) => execFileSync('git', ['show', ...SHOW_OPTIONS, sha], atTop),
    message: (sha) => commitMessage(execFileSync('git', ['cat-file', 'commit', sha], atTop)),
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
    const problem = gitVersionProblem(execFileSync('git', ['--version'], { encoding: 'utf8', stdio: 'pipe' }));
    if (problem) {
      console.error(`scan-commits-privacy: ${problem}`);
      return 2;
    }
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

if (isEntry(import.meta.url, process.argv[1])) process.exit(main(process.argv.slice(2)));
