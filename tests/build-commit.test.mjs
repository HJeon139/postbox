// The build-line commit check the install test uses (#919): tests/build-commit.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCommitMatches } from './build-commit.mjs';

const FULL = '434907aa1c2b3d4e5f60718293a4b5c6d7e8f901';

test('#919: a 7-character commit matches HEAD even when git would abbreviate HEAD to 8', () => {
  assert.equal(buildCommitMatches('434907a', FULL), true);
});

test('#919: another commit does not match HEAD', () => {
  assert.equal(buildCommitMatches('434907b', FULL), false);
  assert.equal(buildCommitMatches('1234567', FULL), false);
});

test('#919: no commit does not match HEAD', () => {
  assert.equal(buildCommitMatches(null, FULL), false);
  assert.equal(buildCommitMatches('', FULL), false);
  assert.equal(buildCommitMatches(undefined, FULL), false);
  assert.equal(buildCommitMatches('434907a', null), false);
});

test('#919: only exactly 7 characters match, not 6 or 8', () => {
  assert.equal(buildCommitMatches('434907', FULL), false);
  assert.equal(buildCommitMatches('434907aa', FULL), false);
});

test('#919: a commit that is not lowercase hex does not match', () => {
  assert.equal(buildCommitMatches('zzzzzzz', 'zzzzzzz1c2b3d4e5f60718293a4b5c6d7e8f901'), false);
  assert.equal(buildCommitMatches('434907A', '434907A1c2b3d4e5f60718293a4b5c6d7e8f901'), false);
});
