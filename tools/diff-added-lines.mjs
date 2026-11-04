// Reads the lines a commit adds out of git’s diff of it, by file, for tools/scan-commits-privacy.mjs (#508). It reads
// only what it’s given, and starts nothing, so tests/scan-commits-privacy.test.mjs tests it on diffs copied from git.

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
 * The lines a commit’s diff adds, by file, from `git show --format= -U0` output, and for a merge from
 * `git show --remerge-diff`, whose file headers may hold its “remerge ” notes. Each hunk’s lines are counted off its
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
  // Whether the line is in a file’s header, between its “diff --git” line and its first hunk or “+++ ” line.
  let inHeader = false;
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
      inHeader = true;
      return;
    }
    if (inHeader && REMERGE_NOTE.test(line)) return;
    if (NEW_PATH.test(line)) {
      path = newPath(line, at);
      inHeader = false;
      return;
    }
    if (BINARY.test(line)) {
      binary++;
      return;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      inHeader = false;
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
