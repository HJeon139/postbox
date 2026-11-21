// #793: a `*` run between a digit and a word character, as in code and math (10**9, x**2, 2*n), was read as emphasis, so
// “range(10**9, 10**10)” showed as “range(109, 1010)” with “9, 10” in bold. It stays as typed; emphasis next to words
// and spaces is unchanged.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../shared/markdown.mjs';

/** The rendered text with its tags, without the paragraph around it. */
const html = (s) => renderMarkdown(s).replace(/^<p[^>]*>|<\/p>\s*$/g, '');
/** The text a reader sees. */
const seen = (s) =>
  html(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&#42;/g, '*');

test('powers and products keep their asterisks, with no emphasis made of them', () => {
  for (const typed of ['range(10**9, 10**10)', 'x**2 + y**2', '2**n and 3*4*5', 'n*2 is 2*n']) {
    assert.equal(seen(typed), typed, typed);
    assert.doesNotMatch(html(typed), /<(strong|em)>/, typed);
  }
});

test('emphasis between spaces and words still renders', () => {
  assert.equal(html('a **bold** word'), 'a <strong>bold</strong> word');
  assert.equal(html('an *italic* word'), 'an <em>italic</em> word');
  assert.equal(html('**10** issues'), '<strong>10</strong> issues');
  assert.equal(html('about *2* of them'), 'about <em>2</em> of them');
  // A closing run before a digit still closes, from the pre-review of #793.
  assert.equal(html('**Q3**2026'), '<strong>Q3</strong>2026');
  assert.equal(html('**total**5'), '<strong>total</strong>5');
  assert.equal(html('the *1*st'), 'the <em>1</em>st');
});

test('a screen reader’s plain text keeps them too, and drops emphasis as before', async () => {
  const { toPlainText } = await import('../shared/markdown-plain.mjs');
  assert.equal(toPlainText('range(10**9, 10**10) and x**2 + y**2'), 'range(10**9, 10**10) and x**2 + y**2');
  assert.equal(toPlainText('a **bold** and *italic* word'), 'a bold and italic word');
});

test('read-aloud text keeps them, with no entity in it', async () => {
  const { plainText } = await import('../shared/text.mjs');
  assert.equal(plainText('Try range(10**9, 10**10).'), 'Try range(10**9, 10**10).');
});
