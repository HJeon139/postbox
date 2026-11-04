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
import { checkFilePrivacy } from './privacy-check.mjs';

// The line that starts each file’s part of a diff.
const FILE_START = /^diff --git /;

// The lines git writes between a file’s “diff --git” line and its first hunk (git’s diff format, “extended headers”).
const EXTENDED_HEADER =
  /^(?:old mode|new mode|deleted file mode|new file mode|copy from|copy to|rename from|rename to|similarity index|dissimilarity index|index) /;

// The old file’s name, before its hunks.
const OLD_PATH = /^--- /;

// The new file’s name, before its hunks: “+++ b/path”, or “+++ /dev/null” for a file the commit deletes.
const NEW_PATH = /^\+\+\+ /;

// What git writes in place of hunks for a binary file.
const BINARY = /^Binary files .* differ$/;

// A hunk’s header and its line counts: “@@ -start,count +start,count @@”, where a count left out means one.
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

// “\ No newline at end of file”, after a hunk’s last line on either side. It isn’t one of the hunk’s lines.
const NO_NEWLINE = /^\\ /;

// C escapes git writes inside a quoted path, by the letter after the backslash.
const C_ESCAPES = /** @type {Record<string, number>} */ ({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 });

// Three octal digits after a backslash: one byte of a path git quoted.
const OCTAL_BYTE = /^[0-7]{3}$/;

/**
 * A path as git writes it after “+++ ”: in double quotes with C escapes when it holds a quote, a backslash or a byte
 * outside printable ASCII, and followed by a tab when it holds a space.
 * @param {string} written
 */
function unquotePath(written) {
  if (!written.startsWith('"')) return written.replace(/\t$/, '');
  const inner = written.slice(1, written.lastIndexOf('"'));
  /** @type {number[]} */
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') {
      bytes.push(...Buffer.from(inner[i]));
      continue;
    }
    const octal = inner.slice(i + 1, i + 4);
    if (OCTAL_BYTE.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
      continue;
    }
    bytes.push(C_ESCAPES[inner[i + 1]] ?? inner.charCodeAt(i + 1));
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The file a “+++ ” line names, from the repository’s root, or null for /dev/null.
 * @param {string} line
 * @param {number} at the line’s number in the diff, for the error
 */
function newPath(line, at) {
  const written = unquotePath(line.slice(4));
  if (written === '/dev/null') return null;
  if (!written.startsWith('b/')) throw new Error(`can’t read git’s diff at line ${at}: the new file’s name has no “b/”`);
  return written.slice(2);
}

/** A hunk header’s line count: one when the header leaves it out. @param {string | undefined} written */
function hunkCount(written) {
  if (written === undefined) return 1;
  return Number(written);
}

/**
 * The lines a commit’s diff adds, by file, from `git show --format= -U0` output. Each hunk’s lines are counted off its
 * header, so an added line that reads “++ b/…” or a removed one that reads “-- a/…” stays in its hunk, and is never
 * taken for the next file’s header. Outside a hunk, a line git’s diff format doesn’t have is an error, and so is a diff
 * that ends inside a hunk: either is a diff this can’t read, and must not pass as one that adds nothing.
 *
 * @param {string} diff
 * @returns {{ files: Map<string, string[]>, binary: number }} the added lines by file, and how many binary files it skipped
 */
export function parseAddedLines(diff) {
  /** @type {Map<string, string[]>} */
  const files = new Map();
  let binary = 0;
  /** @type {string | null} */
  let path = null;
  let removedLeft = 0;
  let addedLeft = 0;
  const lines = diff.split('\n');
  // The diff ends in a newline, which leaves an empty last line that isn’t one of git’s.
  if (lines.at(-1) === '') lines.pop();
  lines.forEach((line, i) => {
    const at = i + 1;
    if (removedLeft + addedLeft > 0) {
      if (NO_NEWLINE.test(line)) return;
      if (line.startsWith('-') && removedLeft > 0) {
        removedLeft--;
        return;
      }
      if (line.startsWith('+') && addedLeft > 0 && path !== null) {
        addedLeft--;
        const added = files.get(path) ?? [];
        added.push(line.slice(1));
        files.set(path, added);
        return;
      }
      throw new Error(`can’t read git’s diff at line ${at}: it doesn’t fit its hunk’s counts`);
    }
    if (FILE_START.test(line)) {
      path = null;
      return;
    }
    if (NEW_PATH.test(line)) {
      path = newPath(line, at);
      return;
    }
    if (BINARY.test(line)) {
      binary++;
      return;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      removedLeft = hunkCount(hunk[1]);
      addedLeft = hunkCount(hunk[2]);
      return;
    }
    if (EXTENDED_HEADER.test(line) || OLD_PATH.test(line) || NO_NEWLINE.test(line)) return;
    throw new Error(`can’t read git’s diff at line ${at}`);
  });
  if (removedLeft + addedLeft > 0) throw new Error('can’t read git’s diff: it ends inside a hunk');
  return { files, binary };
}

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
