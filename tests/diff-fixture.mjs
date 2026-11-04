// git’s diffs, in the shape `git show --format= -U0` prints, copied from its output, for the tests of the diff parser
// (tests/diff-added-lines.test.mjs) and of the commit privacy scan (tests/scan-commits-privacy.test.mjs).

/** git’s diff of one new text file holding these lines. */
export function newFile(path, lines) {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..814f4a4',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ];
}

/** git’s diff of a new binary file. */
export function newBinary(path) {
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..badc806', `Binary files /dev/null and b/${path} differ`];
}

/** git’s diff of a file whose only line was removed. */
export function removedLine(path, line) {
  return [`diff --git a/${path} b/${path}`, 'index 814f4a4..e69de29 100644', `--- a/${path}`, `+++ b/${path}`, '@@ -1 +0,0 @@', `-${line}`];
}

/** The diff these files’ parts make, ending in a newline as git’s does. */
export const diff = (...sections) => `${sections.flat().join('\n')}\n`;
