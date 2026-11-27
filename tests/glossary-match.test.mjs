// Which words of a reply link to a glossary term (shared/glossary-match.mjs, #102).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../shared/markdown.mjs';

/** The words of some text that link to the one term given. */
function linked(term, text) {
  const html = String(renderMarkdown(text, { glossary: [{ term, key: 'k' }] }));
  return [...html.matchAll(/<span class="term"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
}

test('a term of one or two characters links only in its own case (#102)', () => {
  assert.deepEqual(linked('U', 'see u later'), []);
  assert.deepEqual(linked('R', 'see r for details'), []);
  assert.deepEqual(linked('Ux', 'the UX team'), []);
  assert.deepEqual(linked('R', 'see R for details'), ['R']);
  assert.deepEqual(linked('Ux', 'the Ux team'), ['Ux']);
});

test('a short term doesn’t link inside an abbreviation such as R&D or U.S. (#102)', () => {
  assert.deepEqual(linked('R', 'the R&D budget'), []);
  assert.deepEqual(linked('D', 'the R&D budget'), []);
  assert.deepEqual(linked('U', 'the U.S. team'), []);
  assert.deepEqual(linked('S', 'the U.S. team'), []);
  // Spaced, “R & D” reads as two words, which could each be a term, as in “Q & A” with Q defined: R still links.
  assert.deepEqual(linked('R', 'R & D'), ['R']);
});

test('a short term still links as a word of its own (#102)', () => {
  assert.deepEqual(linked('R', 'R:31 says so'), ['R']);
  assert.deepEqual(linked('R', 'R. That is all.'), ['R']);
  assert.deepEqual(linked('R', "R’s rule and R's rule"), ['R', 'R']);
  assert.deepEqual(linked('R', 'see (R), then R.'), ['R', 'R']);
});

test('a longer term keeps its whole-word match in any case (#102)', () => {
  assert.deepEqual(linked('Step 7', 'then step 7 runs'), ['step 7']);
  assert.deepEqual(linked('R:31', 'see r:31 now'), ['r:31']);
  assert.deepEqual(linked('R&D', 'the r&d budget'), ['r&amp;d']);
  assert.deepEqual(linked('Step 7', 'Step 70 is different'), []);
});
