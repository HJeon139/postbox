// The commit privacy scan’s pure parts (tools/scan-commits-privacy.mjs, #508): reading the lines a commit adds out of
// git’s diff (tools/diff-added-lines.mjs), and checking each commit of a range through a git reader. The diffs below are in the shape
// `git show --format= -U0` prints, copied from its output; tests/process/scan-commits-privacy.test.mjs runs real git.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAddedLines } from '../tools/diff-added-lines.mjs';
import { formatFinding, gitVersionProblem, scanCommits } from '../tools/scan-commits-privacy.mjs';

// A made-up home path, built here so this file doesn’t hold one for the tree’s own privacy check to flag.
const HOME = ['', 'Users', 'alice'].join('/');
const HOME_PATH = `${HOME}/x`;
// The home as the checker reports it: from the folder name on, without the slash before it.
const REPORTED_HOME = HOME.slice(1);

/** git’s diff of one new text file holding these lines. */
function newFile(path, lines) {
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
function newBinary(path) {
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..badc806', `Binary files /dev/null and b/${path} differ`];
}

/** git’s diff of a file whose only line was removed. */
function removedLine(path, line) {
  return [`diff --git a/${path} b/${path}`, 'index 814f4a4..e69de29 100644', `--- a/${path}`, `+++ b/${path}`, '@@ -1 +0,0 @@', `-${line}`];
}

const diff = (...sections) => `${sections.flat().join('\n')}\n`;

/** A git reader over commits given as { sha: diff text }, oldest first, with messages given as { sha: message }. */
function fakeGit(history, messages = {}) {
  return {
    commits: () => Object.keys(history),
    show: (sha) => history[sha],
    message: (sha) => messages[sha] ?? `change ${sha}\n`,
  };
}

test('the added lines are grouped by the file they were added to, and removed lines are left out', () => {
  const text = diff(newFile('a.txt', ['one', 'two']), removedLine('b.txt', 'gone'), newFile('c.txt', ['three']));
  const { files } = parseAddedLines(text);
  assert.deepEqual(
    [...files],
    [
      ['a.txt', ['one', 'two']],
      ['c.txt', ['three']],
    ],
  );
});

test('a content line that starts with “++ b/” is an added line, not the header of another file', () => {
  const text = diff(newFile('a.txt', ['++ b/other.txt', `++ ${HOME_PATH}`]));
  const { files } = parseAddedLines(text);
  assert.deepEqual([...files], [['a.txt', ['++ b/other.txt', `++ ${HOME_PATH}`]]]);
});

test('a line after a hunk’s counted lines is read as a header again', () => {
  const text = diff(newFile('a.txt', ['one']), newFile('b.txt', ['two']));
  const { files } = parseAddedLines(text);
  assert.deepEqual([...files.keys()], ['a.txt', 'b.txt']);
});

test('“No newline at end of file” isn’t counted as one of a hunk’s lines', () => {
  const text = diff(newFile('a.txt', ['one']), '\\ No newline at end of file', newFile('b.txt', ['two']));
  const { files } = parseAddedLines(text);
  assert.deepEqual(
    [...files],
    [
      ['a.txt', ['one']],
      ['b.txt', ['two']],
    ],
  );
});

test('a binary file is counted as skipped and adds no lines', () => {
  const { files, binary } = parseAddedLines(diff(newBinary('b.bin'), newFile('a.txt', ['one'])));
  assert.deepEqual([...files.keys()], ['a.txt']);
  assert.equal(binary, 1);
});

test('a rename with no changed lines adds no lines', () => {
  const text = diff(['diff --git a/a.txt b/c.txt', 'similarity index 100%', 'rename from a.txt', 'rename to c.txt']);
  const { files } = parseAddedLines(text);
  assert.equal(files.size, 0);
});

test('a path git quotes is read back as the file’s own name', () => {
  const quoted = (written) => diff(['diff --git x y', '--- /dev/null', `+++ ${written}`, '@@ -0,0 +1 @@', '+one']);
  assert.deepEqual([...parseAddedLines(quoted('"b/odd\\"name.txt"')).files.keys()], ['odd"name.txt']);
  assert.deepEqual([...parseAddedLines(quoted('"b/caf\\303\\251.txt"')).files.keys()], ['café.txt']);
  assert.deepEqual([...parseAddedLines(quoted('b/with space.txt\t')).files.keys()], ['with space.txt']);
});

test('a line git’s diff format doesn’t have, outside a hunk, is an error rather than skipped', () => {
  assert.throws(() => parseAddedLines(diff(['diff --cc a.txt', '@@@ -1,1 -1,1 +1,2 @@@'])), /can’t read git’s diff at line 1/);
  assert.throws(() => parseAddedLines(diff(newFile('a.txt', ['one']), 'surprise')), /can’t read git’s diff at line 8/);
});

test('a diff that ends inside a hunk is an error, not a commit that adds fewer lines', () => {
  const cut = diff(['diff --git a/a.txt b/a.txt', '--- /dev/null', '+++ b/a.txt', '@@ -0,0 +1,2 @@', '+one']);
  assert.throws(() => parseAddedLines(cut), /it ends inside a hunk/);
});

test('the notes `git show --remerge-diff` writes in a merge’s file headers are read past', () => {
  const text = diff(
    ['diff --git a/c.txt b/c.txt', 'remerge CONFLICT (content): Merge conflict in c.txt', 'index ed2f78b..53c74cd 100644'],
    ['--- a/c.txt', '+++ b/c.txt', '@@ -1,3 +1 @@', '-<<<<<<< 215b818 (w)', '-=======', '->>>>>>> 8c2a855 (side)', '+evil'],
    ['diff --git a/k2.txt b/k2.txt', 'remerge CONFLICT (rename/delete): keep.txt renamed to k2.txt in 8c2a855 (side)'],
    newFile('d.txt', ['two']),
  );
  assert.deepEqual(
    [...parseAddedLines(text).files],
    [
      ['c.txt', ['evil']],
      ['d.txt', ['two']],
    ],
  );
});

test('a note like remerge-diff’s, outside a file’s header, is an error rather than skipped', () => {
  const text = diff(newFile('a.txt', ['one']), 'remerge CONFLICT (content): Merge conflict in a.txt');
  assert.throws(() => parseAddedLines(text), /can’t read git’s diff at line 8/);
});

test('a home path a commit adds is reported with its commit and file', () => {
  const sha = 'abcdef1234567890';
  const result = scanCommits('main..HEAD', fakeGit({ [sha]: diff(newFile('notes.md', [`see ${HOME_PATH}`])) }));
  assert.deepEqual(result.findings, [{ sha, path: 'notes.md', violation: `home path: ${REPORTED_HOME}` }]);
  assert.equal(formatFinding(result.findings[0]), `abcdef1 notes.md: home path: ${REPORTED_HOME}`);
});

test('a private string added in one commit and removed in a later one is still reported', () => {
  const history = {
    aaaaaaa1: diff(newFile('notes.md', [HOME_PATH])),
    bbbbbbb2: diff(removedLine('notes.md', HOME_PATH)),
  };
  const result = scanCommits('main..HEAD', fakeGit(history));
  assert.deepEqual(
    result.findings.map((f) => f.sha),
    ['aaaaaaa1'],
  );
});

test('the privacy checker’s own files are checked like any other, at its old path and its new one', () => {
  for (const path of ['tools/privacy-check.mjs', 'tests/privacy-check.mjs', 'tests/fixtures-privacy.test.mjs']) {
    const result = scanCommits('main..HEAD', fakeGit({ aaaaaaa1: diff(newFile(path, [HOME_PATH])) }));
    assert.deepEqual(
      result.findings.map((f) => f.path),
      [path],
    );
  }
});

test('a binary file a commit adds isn’t checked, and the summary counts it', () => {
  const result = scanCommits('main..HEAD', fakeGit({ aaaaaaa1: diff(newBinary('b.bin')) }));
  assert.deepEqual(result, { commits: 1, files: 0, lines: 0, binary: 1, findings: [] });
});

test('an empty range checks nothing and finds nothing', () => {
  assert.deepEqual(scanCommits('main..main', fakeGit({})), { commits: 0, files: 0, lines: 0, binary: 0, findings: [] });
});

test('a file whose added lines hold a zero byte is skipped as binary, as git would call it', () => {
  const result = scanCommits('main..HEAD', fakeGit({ aaaaaaa1: diff(newFile('b.bin', [`\0${HOME_PATH}`])) }));
  assert.deepEqual(result, { commits: 1, files: 0, lines: 0, binary: 1, findings: [] });
});

test('a home path in a commit’s message is reported as the message’s', () => {
  const sha = 'abcdef1234567890';
  const result = scanCommits('main..HEAD', fakeGit({ [sha]: '' }, { [sha]: `change\n\nSeen-at: ${HOME_PATH}\n` }));
  assert.deepEqual(result.findings, [{ sha, path: null, violation: `home path: ${REPORTED_HOME}` }]);
  assert.equal(formatFinding(result.findings[0]), `abcdef1 message: home path: ${REPORTED_HOME}`);
});

test('git older than 2.36, which has no --remerge-diff, is refused, naming its version and the minimum', () => {
  assert.equal(gitVersionProblem('git version 2.35.9\n'), 'git 2.35.9 is too old: the scan needs git 2.36.0 or later, for --remerge-diff.');
  assert.match(gitVersionProblem('git version 1.99.0') ?? '', /git 1\.99\.0 is too old/);
  assert.equal(gitVersionProblem('git version 2.36.0\n'), null);
  assert.equal(gitVersionProblem('git version 2.50.1\n'), null);
  assert.equal(gitVersionProblem('git version 3.0.0\n'), null, 'a later major version is fine whatever its minor');
  assert.equal(gitVersionProblem('git version 2.39.3 (Apple Git-145)\n'), null, 'a vendor suffix is read past');
  assert.equal(gitVersionProblem('git version 2.45.1.windows.1\n'), null);
  assert.match(gitVersionProblem('git version 2.35.1.windows.2') ?? '', /git 2\.35\.1 is too old/);
  assert.match(gitVersionProblem('not git') ?? '', /can’t read git’s version from “not git”/);
});
