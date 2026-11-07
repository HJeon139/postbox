// Reads the lines a diff without context (`-U0`) adds, by file: their text, for tools/scan-commits-privacy.mjs (#508),
// and their line ranges, for tools/lint-ternary.mjs (#685). It’s the one parser of those diffs, so both read them as
// strictly. It reads only what it’s given, and starts nothing, so tests/diff-added-lines.test.mjs tests it on diffs
// copied from git.

// The diff options that fix the shape readDiff reads, so a person’s own git config can’t change it: hunks without
// context, whatever diff.interHunkContext says; no colors, external diff or text conversion; renames; and “a/” and “b/”
// prefixes on every file’s path from the repository’s root, whatever diff.noprefix, diff.mnemonicPrefix or
// diff.relative say. Both tools that read such diffs ask git for them with these.
export const DIFF_OPTIONS = Object.freeze([
  ...['-U0', '--inter-hunk-context=0', '--no-color', '--no-ext-diff', '--no-textconv', '-M'],
  ...['--no-relative', '--src-prefix=a/', '--dst-prefix=b/'],
]);

// The line that starts each file’s part of a diff.
const FILE_START = /^diff --git /;

// The lines git writes between a file’s “diff --git” line and its first hunk (git’s diff format, “extended headers”).
const EXTENDED_HEADER =
  /^(?:old mode|new mode|deleted file mode|new file mode|copy from|copy to|rename from|rename to|similarity index|dissimilarity index|index) /;

// A note `git show --remerge-diff` writes in a merge’s file header, such as “remerge CONFLICT (content): Merge conflict
// in c.txt”: what the automatic merge left for the person to resolve.
const REMERGE_NOTE = /^remerge /;

// The old file’s name, before its hunks.
const OLD_PATH = /^--- /;

// The new file’s name, before its hunks: “+++ b/path”, or “+++ /dev/null” for a file the commit deletes.
const NEW_PATH = /^\+\+\+ /;

// What git writes in place of hunks for a binary file.
const BINARY = /^Binary files .* differ$/;

// A hunk’s header, its line counts and its first new line: “@@ -start,count +start,count @@”, where a count left out means one.
const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

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
 * A file’s added lines in a diff: their text, and their ranges of line numbers in the new file.
 * @typedef {{ lines: string[], ranges: { start: number, end: number }[] }} Added
 */

/**
 * The lines a diff adds, by file, from `git show --format= -U0` or `git diff -U0` output, and for a merge from
 * `git show --remerge-diff`, whose file headers may hold its “remerge ” notes. Each hunk’s lines are counted off its
 * header, so an added line that reads “++ b/…” or a removed one that reads “-- a/…” stays in its hunk, and is never
 * taken for the next file’s header. Outside a hunk, a line git’s diff format doesn’t have is an error, and so is a diff
 * that ends inside a hunk: either is a diff this can’t read, and must not pass as one that adds nothing.
 *
 * @param {string} diff
 * @returns {{ files: Map<string, Added>, binary: number, deleted: { at: number, line: string }[] }} the added lines by
 *   file, how many binary files it skipped, and the “+++ /dev/null” lines of the files it deletes
 */
function readDiff(diff) {
  /** @type {Map<string, Added>} */
  const files = new Map();
  const result = { files, binary: 0, deleted: /** @type {{ at: number, line: string }[]} */ ([]) };
  /** @type {Added | null} */
  let file = null;
  // Whether the line is in a file’s header, between its “diff --git” line and its first hunk or “+++ ” line.
  let inHeader = false;
  const left = { removed: 0, added: 0 };
  const lines = diff.split('\n');
  // The diff ends in a newline, which leaves an empty last line that isn’t one of git’s.
  if (lines.at(-1) === '') lines.pop();
  lines.forEach((line, i) => {
    const at = i + 1;
    if (left.removed + left.added > 0) {
      hunkLine(line, at, left, file);
      return;
    }
    if (FILE_START.test(line)) {
      // The file stays the last one named until this one’s “+++ ” line, as a hunk before that line fails.
      inHeader = true;
      return;
    }
    if (inHeader && REMERGE_NOTE.test(line)) return;
    if (NEW_PATH.test(line)) {
      file = fileOf(files, line, at, result.deleted);
      inHeader = false;
      return;
    }
    if (BINARY.test(line)) {
      result.binary++;
      return;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      // A hunk in a file’s header has no “+++ ” line naming its file, so its lines can’t be put down to any file.
      if (inHeader) throw new Error(`can’t read git’s diff at line ${at}: a hunk before its file’s “+++ ” line`);
      startHunk(hunk, left, file);
      return;
    }
    if (EXTENDED_HEADER.test(line) || OLD_PATH.test(line) || NO_NEWLINE.test(line)) return;
    throw new Error(`can’t read git’s diff at line ${at}`);
  });
  if (left.removed + left.added > 0) throw new Error('can’t read git’s diff: it ends inside a hunk');
  return result;
}

/**
 * The added lines of the file a “+++ ” line names, kept in files when it adds any, or null for /dev/null, which is
 * noted in deleted.
 * @param {Map<string, Added>} files @param {string} line @param {number} at @param {{ at: number, line: string }[]} deleted
 * @returns {Added | null}
 */
function fileOf(files, line, at, deleted) {
  const path = newPath(line, at);
  if (path === null) {
    deleted.push({ at, line });
    return null;
  }
  const file = files.get(path) ?? { lines: [], ranges: [] };
  files.set(path, file);
  return file;
}

/**
 * Starts a hunk: its counts of lines left to read, and its added range in the file’s new lines, if it adds any.
 * @param {RegExpExecArray} hunk @param {{ removed: number, added: number }} left @param {Added | null} file
 */
function startHunk(hunk, left, file) {
  left.removed = hunkCount(hunk[1]);
  left.added = hunkCount(hunk[3]);
  const start = Number(hunk[2]);
  if (left.added > 0 && file) file.ranges.push({ start, end: start + left.added - 1 });
}

/**
 * Reads one of a hunk’s lines, counting it off what the hunk has left.
 * @param {string} line @param {number} at @param {{ removed: number, added: number }} left @param {Added | null} file
 */
function hunkLine(line, at, left, file) {
  if (NO_NEWLINE.test(line)) return;
  if (line.startsWith('-') && left.removed > 0) {
    left.removed--;
    return;
  }
  if (line.startsWith('+') && left.added > 0 && file) {
    left.added--;
    file.lines.push(line.slice(1));
    return;
  }
  throw new Error(`can’t read git’s diff at line ${at}: it doesn’t fit its hunk’s counts`);
}

/** The files a diff adds lines to, left out when it adds none. @param {Map<string, Added>} files */
function withAdded(files) {
  return [...files].filter(([, file]) => file.lines.length > 0);
}

/**
 * The lines a commit’s diff adds, by file, read as readDiff reads them; a file it deletes adds none.
 * @param {string} diff
 * @returns {{ files: Map<string, string[]>, ranges: Map<string, { start: number, end: number }[]>, binary: number }} the
 *   added lines by file, their ranges of line numbers in the new file, and how many binary files it skipped
 */
export function parseAddedLines(diff) {
  const { files, binary } = readDiff(diff);
  const added = withAdded(files);
  return { files: new Map(added.map(([path, file]) => [path, file.lines])), ranges: new Map(added.map(([path, file]) => [path, file.ranges])), binary };
}

/**
 * The line ranges a `git diff -U0` adds, by file, each its first and last line, read as readDiff reads them. A diff
 * that deletes a file fails: lint-ternary asks only for added, modified and renamed files, so a “+++ /dev/null” there is
 * a diff it misread, and must not drop that file’s lines.
 * @param {string} diff
 * @returns {Map<string, { start: number, end: number }[]>}
 */
export function addedRanges(diff) {
  const { files, deleted } = readDiff(diff);
  if (deleted.length) throw new Error(`can’t read git’s diff at line ${deleted[0].at}: “${deleted[0].line}” names no new file`);
  return new Map(withAdded(files).map(([path, file]) => [path, file.ranges]));
}
