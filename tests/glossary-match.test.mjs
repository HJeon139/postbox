// Which words of a reply link to a glossary term (shared/glossary-match.mjs, #102).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../shared/markdown.mjs';
import { termKey } from '../shared/term-key.mjs';

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

test('dash variants of a term link to it, both ways (#102)', () => {
  assert.deepEqual(linked('U:45–52', 'see U:45-52 now'), ['U:45-52']);
  assert.deepEqual(linked('U:45-52', 'see U:45–52 now'), ['U:45–52']);
  assert.deepEqual(linked('U:45-52', 'see U:45—52 now'), ['U:45—52']);
  assert.deepEqual(linked('pre–flight', 'a pre-flight check'), ['pre-flight']);
  assert.deepEqual(linked('U:45-52', 'see U:45 52 now'), []);
});

test('a minus sign or a figure dash links like a hyphen (#102)', () => {
  assert.deepEqual(linked('U:45–52', 'see U:45\u221252 now'), ['U:45\u221252']);
  assert.deepEqual(linked('U:45–52', 'see U:45\u201252 now'), ['U:45\u201252']);
  assert.deepEqual(linked('U:45\u221252', 'see U:45-52 now'), ['U:45-52']);
});

test('straight and curly quote variants of a term link to it, both ways (#102)', () => {
  assert.deepEqual(linked('Bob’s rule', "Bob's rule holds"), ['Bob&#39;s rule']);
  assert.deepEqual(linked("Bob's rule", 'Bob’s rule holds'), ['Bob’s rule']);
  assert.deepEqual(linked('the “fast” path', 'the "fast" path'), ['the &quot;fast&quot; path']);
  assert.deepEqual(linked('the "fast" path', 'the “fast” path'), ['the “fast” path']);
  // A short term folds the same way, and keeps its own case.
  assert.deepEqual(linked('R’', "R' and r' differ"), ['R&#39;']);
});

test('a term’s key treats dash and quote variants alike (#102)', () => {
  assert.equal(termKey('U:45–52'), termKey('U:45-52'));
  assert.equal(termKey('Bob’s rule'), termKey("Bob's rule"));
});

/** Some text rendered with the one term given, as HTML. */
const rendered = (term, text) => String(renderMarkdown(text, { glossary: [{ term, key: 'k' }] }));

test('a term doesn’t link inside an HTML entity the escaped text holds (#102)', () => {
  assert.equal(rendered('AMP', 'the R&D budget'), '<p>the R&amp;D budget</p>');
  assert.equal(rendered('amp', 'the R&D budget'), '<p>the R&amp;D budget</p>');
  assert.equal(rendered('39', "Bob's rule"), '<p>Bob&#39;s rule</p>');
  assert.equal(rendered('quot', 'the "fast" path'), '<p>the &quot;fast&quot; path</p>');
  assert.equal(rendered('lt', 'a < b'), '<p>a &lt; b</p>');
  assert.equal(rendered('#39', "Bob's rule"), '<p>Bob&#39;s rule</p>');
});

test('a term spelled like an entity’s name still links as a word of its own (#102)', () => {
  assert.deepEqual(linked('AMP', 'the AMP team and R&D'), ['AMP']);
  assert.deepEqual(linked('lt', 'lt is short and a < b'), ['lt']);
});
