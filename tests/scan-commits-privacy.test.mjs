// The commit privacy scan’s pure parts (tools/scan-commits-privacy.mjs, #508): checking each commit of a range through a
// git reader. The diffs are in the shape `git show --format= -U0` prints (tests/diff-fixture.mjs), and the parser that
// reads them is tested in tests/diff-added-lines.test.mjs; tests/process/scan-commits-privacy.test.mjs runs real git.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFinding, gitVersionProblem, scanCommits } from '../tools/scan-commits-privacy.mjs';
import { diff, newBinary, newFile, removedLine } from './diff-fixture.mjs';

// A made-up home path, built here so this file doesn’t hold one for the tree’s own privacy check to flag.
const HOME = ['', 'Users', 'alice'].join('/');
const HOME_PATH = `${HOME}/x`;

/** A git reader over commits given as { sha: diff text }, oldest first, with messages given as { sha: message }. */
function fakeGit(history, messages = {}) {
  return {
    commits: () => Object.keys(history),
    show: (sha) => history[sha],
    message: (sha) => messages[sha] ?? `change ${sha}\n`,
  };
}

test('a home path a commit adds is reported with its commit and file', () => {
  const sha = 'abcdef1234567890';
  const result = scanCommits('main..HEAD', fakeGit({ [sha]: diff(newFile('notes.md', [`see ${HOME_PATH}`])) }));
  assert.deepEqual(result.findings, [{ sha, path: 'notes.md', violation: 'home path at line 1' }]);
  assert.equal(formatFinding(result.findings[0]), 'abcdef1 notes.md: home path at line 1');
});

/** A made-up address at a domain that isn’t reserved for examples, for a file’s name. */
const ADDRESS = ['jdoe', 'corp.com'].join('@');

test('a private name of a file a commit adds is reported, though what the file holds is clean (#785)', () => {
  const sha = 'abcdef1234567890';
  const result = scanCommits('main..HEAD', fakeGit({ [sha]: diff(newFile(`x/${ADDRESS}.txt`, ['nothing private'])) }));
  assert.deepEqual(result.findings, [{ sha, path: `x/${ADDRESS}.txt`, violation: 'email in the file name' }]);
  assert.equal(formatFinding(result.findings[0]), 'abcdef1 a file’s name: email in the file name', 'the name isn’t printed');
  const named = `${HOME.slice(1)}/notes.md`;
  const home = scanCommits('main..HEAD', fakeGit({ [sha]: diff(newFile(named, ['nothing private'])) }));
  assert.deepEqual(home.findings, [{ sha, path: named, violation: 'home path in the file name' }]);
});

test('a binary file’s private name is reported, though its bytes are skipped (#785)', () => {
  const result = scanCommits('main..HEAD', fakeGit({ aaaaaaa1: diff(newFile(`${ADDRESS}.png`, ['\0PNG'])) }));
  assert.deepEqual(result.findings, [{ sha: 'aaaaaaa1', path: `${ADDRESS}.png`, violation: 'email in the file name' }]);
  assert.equal(result.binary, 1);
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
  assert.deepEqual(result.findings, [{ sha, path: null, violation: 'home path at line 3' }]);
  assert.equal(formatFinding(result.findings[0]), 'abcdef1 message: home path at line 3');
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
