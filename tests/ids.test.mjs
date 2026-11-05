import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newId } from '../server/ids.mjs';

// newId’s random source, as base64url text: each string is one draw of 6 bytes, which encodes to 8 characters.
const draws = (...texts) => {
  const left = texts.map((t) => Buffer.from(t, 'base64url'));
  return (n) => {
    const next = left.shift();
    assert.equal(next?.length, n, 'newId draws 6 bytes at a time, and no more often than the test gave');
    return next;
  };
};

test('newId draws again until it has 8 letters or digits, when the bytes come out as - and _ (#713)', () => {
  assert.equal(newId('ep', draws('________', 'ab-_cd-_', 'EFGHIJKL')), 'ep_abcdEFGH', 'the first draw keeps nothing, the second 4');
});

test('every id newId makes is its prefix, _, and exactly 8 letters or digits (#713)', () => {
  for (let i = 0; i < 20000; i++) {
    const id = newId('ep');
    assert.match(id, /^ep_[A-Za-z0-9]{8}$/, `id ${i}: ${id}`);
  }
});
