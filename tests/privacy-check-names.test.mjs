// The privacy checker (tools/privacy-check.mjs) reads each committed file’s name as well as its text: a name is
// published as surely as what the file holds (#785). Every example is built at run time, as in
// tests/fixtures-privacy.test.mjs, so this file’s own text holds none.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFilesPrivacy } from '../tools/privacy-check.mjs';

/** A made-up address at a domain that isn’t reserved for examples. */
const ADDRESS = ['jdoe', 'corp.com'].join('@');

/** A Claude Code project slug of a made-up home. */
const HOME_SLUG = ['', 'Users', 'alice', 'postbox'].join('-');

test('the tree scan flags a private file name, though what the file holds is clean (#785)', () => {
  const files = new Map([
    [`notes/${ADDRESS}.txt`, Buffer.from('nothing private\n')],
    [`tests/fixtures/${HOME_SLUG}.jsonl`, Buffer.from('{}\n')],
    ['docs/clean.md', Buffer.from('nothing private\n')],
  ]);
  const scan = checkFilesPrivacy([...files.keys()], (path) => files.get(path) ?? null);
  assert.deepEqual(scan.findings, [
    { path: `notes/${ADDRESS}.txt`, violations: ['email in the file name'] },
    { path: `tests/fixtures/${HOME_SLUG}.jsonl`, violations: ['home path in the file name'] },
  ]);
  assert.equal(scan.checked, 3, 'each file’s text is checked too');
});

test('the tree scan flags a binary file’s private name, though it doesn’t read the file (#785)', () => {
  const png = Buffer.from([0x89, 0x50, 0x00, 0x2f]);
  const scan = checkFilesPrivacy([`screenshots/${ADDRESS}.png`], () => png);
  assert.deepEqual(scan.findings, [{ path: `screenshots/${ADDRESS}.png`, violations: ['email in the file name'] }]);
  assert.equal(scan.checked, 0, 'a binary file’s bytes aren’t counted as checked');
});

test('the tree scan skips the name of a file that’s gone from the working tree, as it skips its text', () => {
  assert.deepEqual(
    checkFilesPrivacy([`notes/${ADDRESS}.txt`], () => null),
    { checked: 0, findings: [] },
  );
});
