// What the commit privacy scan (tools/scan-commits-privacy.mjs) and the diff parser it reads commits with
// (tools/diff-added-lines.mjs) say when they stop or find something. CI prints it to its public log, so no message
// holds a path or a line of a diff, and a file whose name is private is named by its place in the commit (#905). Each
// spec feeds a message a quote, “<”, “&”, a zero byte and a home path, and checks the message exactly. Every example is
// built at run time, as in tests/fixtures-privacy.test.mjs, so this file’s own text holds none.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedRanges, parseAddedLines } from '../tools/diff-added-lines.mjs';
import { formatFinding, listedFiles, scanCommits } from '../tools/scan-commits-privacy.mjs';
import { diff, newFile } from './diff-fixture.mjs';

/** A made-up home path. */
const HOME = ['', 'Users', 'alice', 'x'].join('/');

/** Text no message may repeat any part of: a quote, “<”, “&”, a zero byte and a home path. */
const HOSTILE = `"<&\0${HOME}`;

/** The parts of a value a message must not hold: each run of three characters in it. @param {string} value */
function pieces(value) {
  const found = new Set();
  for (let i = 0; i + 3 <= value.length; i++) found.add(value.slice(i, i + 3));
  return [...found];
}

/** Asserts a message holds no piece of the value. @param {string} message @param {string} value */
function holdsNone(message, value) {
  const leaked = pieces(value).filter((piece) => message.includes(piece));
  assert.deepEqual(leaked, [], `“${message}” repeats part of what it read`);
}

/** Asserts a call throws exactly this message, and that it holds no piece of the hostile text. */
function throwsOnly(call, message) {
  assert.throws(call, (error) => {
    assert.equal(error.message, message);
    holdsNone(error.message, HOSTILE);
    return true;
  });
}

test('each error the diff parser throws names a line of the diff by its number, and holds none of it (#905)', () => {
  const cases = [
    [diff(newFile('a.txt', ['one']), `surprise ${HOSTILE}`), 'can’t read git’s diff at line 8'],
    [diff(['diff --git a/x b/x', `+++ x/${HOSTILE}`]), 'can’t read git’s diff at line 2: the new file’s name has no “b/”'],
    [diff(['diff --git a/x b/x', '@@ -0,0 +1 @@', `+${HOSTILE}`]), 'can’t read git’s diff at line 2: a hunk before its file’s “+++ ” line'],
    [diff(['--- a/x', '+++ b/x', '@@ -0,0 +1 @@', `-${HOSTILE}`]), 'can’t read git’s diff at line 4: it doesn’t fit its hunk’s counts'],
    [diff(['--- a/x', '+++ b/x', '@@ -0,0 +1,2 @@', `+${HOSTILE}`]), 'can’t read git’s diff: it ends inside a hunk'],
  ];
  for (const [text, message] of cases) {
    throwsOnly(() => parseAddedLines(text), message);
    throwsOnly(() => addedRanges(text), message);
  }
});

test('a “+++ ” line that names no new file fails without repeating the line, whatever follows its quotes (#905)', () => {
  const header = `+++ "/dev/null"${HOSTILE.slice(1)}`;
  const text = diff(['diff --git a/x b/x', 'deleted file mode 100644', '--- a/x', header, '@@ -1 +0,0 @@', `-${HOSTILE}`]);
  throwsOnly(() => addedRanges(text), 'can’t read git’s diff at line 4: “+++ /dev/null” names no new file');
  assert.deepEqual(parseAddedLines(text).files, new Map(), 'the scan reads it as a file the commit deletes');
});

/** A git reader over one commit, its diff and the files git lists for it. */
const oneCommit = (shown, files = []) => ({ commits: () => ['fefefe0123456789'], show: () => shown, message: () => 'x\n', names: () => files });

test('a diff the scan can’t read stops it, naming the commit and the line’s number, not the line (#905)', () => {
  const git = oneCommit(diff(newFile('a.txt', ['one']), `surprise ${HOSTILE}`));
  throwsOnly(() => scanCommits('main..HEAD', git), 'commit fefefe0: can’t read git’s diff at line 8');
});

test('a file whose name is private is named by its place in git’s list of the commit’s files, deletions too (#905)', () => {
  const name = `x/${HOSTILE}/n.md`;
  const files = [
    { status: 'D', path: 'a.md' },
    { status: 'A', path: 'clean.md' },
    { status: 'A', path: name },
  ];
  const git = oneCommit(diff(newFile('clean.md', ['clean']), newFile(name, [`see ${HOME}`])), files);
  const printed = scanCommits('main..HEAD', git).findings.map(formatFinding);
  const where = 'fefefe0 file 3 of git show --name-only';
  assert.deepEqual(printed, [`${where}: home path in the file name`, `${where}: home path at line 1`]);
  for (const line of printed) holdsNone(line, name);
});

test('a private name git doesn’t list for the commit is counted after the files it does, each once (#905)', () => {
  const name = `x/${HOSTILE}/n.md`;
  const git = oneCommit(diff(newFile('clean.md', ['clean']), newFile(name, ['clean'])), [{ status: 'A', path: 'clean.md' }]);
  assert.deepEqual(scanCommits('main..HEAD', git).findings.map(formatFinding), ['fefefe0 file 2 of git show --name-only: home path in the file name']);
});

test('only the names of the files a commit adds, copies or renames are checked, not those it deletes or changes (#905)', () => {
  const name = (status) => ({ status, path: `${status}${HOME}.md` });
  const git = oneCommit('', ['A', 'C075', 'R100', 'D', 'M', 'T'].map(name));
  const found = scanCommits('main..HEAD', git).findings;
  assert.deepEqual(
    found.map(({ path, place }) => [path.slice(0, 4), place]),
    [
      ['A/Us', 1],
      ['C075', 2],
      ['R100', 3],
    ],
  );
});

test('git’s list of a commit’s files is read by status, a rename or a copy by its new name (#905)', () => {
  const quoted = `"<&${HOME}.md`; // git ends each name with a zero byte, so a name holds none
  const output = ['A', 'new.md', 'R100', 'old.md', 'moved.md', 'D', 'gone.md', 'M', quoted, 'C075', 'src.md', 'copy.md', ''].join('\0');
  assert.deepEqual(listedFiles(output), [
    { status: 'A', path: 'new.md' },
    { status: 'R100', path: 'moved.md' },
    { status: 'D', path: 'gone.md' },
    { status: 'M', path: quoted },
    { status: 'C075', path: 'copy.md' },
  ]);
  assert.deepEqual(listedFiles(''), [], 'a commit that changes no file');
});
