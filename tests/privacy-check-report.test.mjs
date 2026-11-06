// What the privacy checks print (tools/privacy-check.mjs, tools/scan-commits-privacy.mjs). CI’s log is public and kept
// for 90 days, so a finding names its kind, its file and its line, and never any part of what it found (#784): not an
// address, a home, a token’s first characters, nor a file’s private name. Every example is built at run time, as in
// tests/fixtures-privacy.test.mjs, so this file’s own text holds none.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkContentPrivacy } from '../tools/privacy-check.mjs';
import { formatFinding, scanCommits } from '../tools/scan-commits-privacy.mjs';
import { diff, newFile } from './diff-fixture.mjs';

/** A made-up installation id that isn’t all zeros. */
const ID = ['12345678', 'abcd', '1234', 'abcd', '123456789abc'].join('-');

/** Made-up private strings of each kind the checker finds, by kind: the text a file holds, and its private part, which
 * shares no three characters with the commit “fefefe0” or the file “notes.md”. */
const SECRETS = {
  email: { text: ['jdoe', 'corp.com'].join('@') },
  'home path': { text: ['', 'Users', 'alice', 'x'].join('/') },
  'home slug': { text: ['', 'Users', 'alice', 'x'].join('-') },
  'GitHub token': { text: `ghp_${'Ab3'.repeat(14)}` },
  'Anthropic key': { text: `sk-ant-api03-${'Ab3'.repeat(14)}` },
  'Bearer token': { text: `Bearer ${'Xy7'.repeat(10)}` },
  installationId: { text: JSON.stringify({ installationId: ID }), secret: ID },
  uid: { text: JSON.stringify({ uid: 501 }), secret: '501' },
  utilization: { text: JSON.stringify({ utilization: 0.13 }), secret: '0.13' },
  connector: { text: JSON.stringify({ name: 'claude.ai Alice Trip Diary' }), secret: 'Alice Trip Diary' },
};

/** The parts of a value a printed line must not hold: each run of three characters in it. @param {string} value */
function pieces(value) {
  const found = new Set();
  for (let i = 0; i + 3 <= value.length; i++) found.add(value.slice(i, i + 3));
  return [...found];
}

/** Asserts a printed line holds no piece of the value. @param {string} line @param {string} value @param {string} kind */
function holdsNone(line, value, kind) {
  const leaked = pieces(value).filter((piece) => line.includes(piece));
  assert.deepEqual(leaked, [], `${kind}: “${line}” repeats part of what it found`);
}

test('a finding in a file names its kind and line, and prints no part of the value (#784)', () => {
  for (const [kind, { text, secret = text }] of Object.entries(SECRETS)) {
    const result = scanCommits('main..HEAD', {
      commits: () => ['fefefe0123456789'],
      show: () => diff(newFile('notes.md', ['clean', `see ${text}`])),
      message: () => 'x\n',
    });
    assert.equal(result.findings.length > 0, true, `${kind} is found`);
    for (const finding of result.findings) {
      holdsNone(formatFinding(finding), secret, kind);
      assert.match(formatFinding(finding), /^fefefe0 notes\.md: [a-zA-Z ]+ at line 2$/, kind);
    }
  }
});

test('a finding in a commit’s message, or in a file’s name, prints no part of the value either (#784)', () => {
  const value = SECRETS.email.text;
  const git = { commits: () => ['fefefe0123456789'], show: () => diff(newFile(`x/${value}.txt`, ['clean'])), message: () => `x\n\nSeen-by: ${value}\n` };
  const printed = scanCommits('main..HEAD', git).findings.map(formatFinding);
  assert.equal(printed.length, 2);
  for (const line of printed) holdsNone(line, value, 'email');
  assert.deepEqual(printed, ['fefefe0 message: email at line 3', 'fefefe0 a file’s name: email in the file name']);
});

test('checkContentPrivacy reports the kind and the line, and no part of the value (#784)', () => {
  assert.deepEqual(checkContentPrivacy(`one\ntwo\nmail ${SECRETS.email.text}\n`), ['email at line 3']);
  for (const [kind, { text, secret = text }] of Object.entries(SECRETS)) {
    for (const violation of checkContentPrivacy(text)) holdsNone(violation, secret, kind);
  }
});

test('a finding in a commit names the line in the file, not its place among the lines the commit adds (#784)', () => {
  const hunk = [
    'diff --git a/n.md b/n.md',
    'index 814f4a4..e69de29 100644',
    '--- a/n.md',
    '+++ b/n.md',
    '@@ -9,0 +10,2 @@',
    '+clean',
    `+${SECRETS.email.text}`,
  ];
  const git = { commits: () => ['fefefe0123456789'], show: () => diff(hunk), message: () => 'x\n' };
  assert.deepEqual(scanCommits('main..HEAD', git).findings.map(formatFinding), ['fefefe0 n.md: email at line 11']);
});
