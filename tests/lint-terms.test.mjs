// The undefined-term lint (server/lint.mjs), on the coined references a reader can’t decode on sight (#102).
// tests/lint.test.mjs is the project lints’ (tools/lint-*.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintTerms, numberedTerms } from '../server/lint.mjs';

/** The terms the lint flags in a reply, with an empty glossary. */
const flagged = (text, glossary = {}) => lintTerms(text, glossary).map((t) => t.term);

test('a capital-letter citation such as R:31 or U:45–52 is flagged until it’s defined', () => {
  assert.deepEqual(flagged('As R:31 says, and U:45–52 shows.'), ['R:31', 'U:45–52']);
  assert.deepEqual(flagged('See U:45-52.'), ['U:45-52']);
});

test('a section such as §4.2 is flagged until it’s defined', () => {
  assert.deepEqual(flagged('Per §4.2, and § 3 before it.'), ['§4.2', '§ 3']);
});

test('a placeholder such as #A is flagged until it’s defined', () => {
  assert.deepEqual(flagged('File sub-issue #A, then #B.'), ['#A', '#B']);
});

test('a time, an issue number, a line number, a table, a color and lowercase forms are left alone', () => {
  assert.deepEqual(flagged('Meet at 10:30 about #208, L120 of the L2 cache, Table 3 and the #ABC color.'), []);
  assert.deepEqual(flagged('Lowercase r:31 and #a are prose, as are AR:31 and a/#A.'), []);
});

test('a coined reference in a code span or a fence isn’t flagged', () => {
  assert.deepEqual(flagged('Run `R:31` and `#A` and `§4.2`.\n\n```\nU:45-52\n```'), []);
});

test('a defined citation isn’t flagged, whichever dash it’s written with', () => {
  const glossary = { 'u-45-52': { term: 'U:45–52' }, 'r-31': { term: 'R:31' } };
  assert.deepEqual(flagged('U:45-52 and U:45–52 and R:31.', glossary), []);
});

test('a citation the person introduced isn’t flagged', () => {
  const introduced = numberedTerms('what does r:31 mean, and §4.2?');
  assert.deepEqual(lintTerms('R:31 and §4.2 say so.', {}, introduced), []);
});
