// #793: a `*` run between a digit and a word character, as in code and math (10**9, x**2, 2*n), was read as emphasis, so
// “range(10**9, 10**10)” showed as “range(109, 1010)” with “9, 10” in bold. It stays as typed; emphasis next to words
// and spaces is unchanged.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../shared/markdown.mjs';
import { stripTags } from '../shared/markdown-inline.mjs';

/** The rendered text with its tags, without the paragraph around it. */
const html = (s) => renderMarkdown(s).replace(/^<p[^>]*>|<\/p>\s*$/g, '');
/** The text a reader sees. */
const seen = (s) => stripTags(html(s)).replace(/&#42;/g, '*');

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

test('plain text keeps a character the placeholder could be, and a code span’s asterisks don’t move the count', async () => {
  const { toPlainText } = await import('../shared/markdown-plain.mjs');
  assert.equal(toPlainText('a \uE000 b'), 'a \uE000 b', 'a private-use character stays as it was');
  assert.equal(toPlainText('Run `a**b`, then 10**9.'), 'Run a**b, then 10**9.');
  assert.equal(toPlainText('`x*y` and 2*n and *word*'), 'x*y and 2*n and word');
});

test('plain text reads a code span of any backtick run as the renderer does, and always finds a placeholder', async () => {
  const { toPlainText } = await import('../shared/markdown-plain.mjs');
  assert.equal(toPlainText('Run ``a**b`` then 10**9.'), 'Run a**b then 10**9.');
  // A run of two holds a single backtick, and drops one space each side, as the renderer’s code span does.
  assert.equal(toPlainText('Say `` a`b*c `` then 2*n*k.'), 'Say a`b*c then 2*n*k.');
  // A run with no close of its length is text, all of it, as the renderer leaves it.
  assert.equal(toPlainText('x ``a`b 2*n*k'), 'x ``a`b 2*n*k');
  // A close inside a longer run leaves the rest to open the next span, as the renderer reads it (pre-review).
  assert.equal(toPlainText('`a`` b*c` *d*'), 'a b*c d');
  assert.equal(toPlainText('`a``b*c` 2*n'), 'ab*c 2*n');
  // Three backticks mid-line are a code span, not a fence; a fence opens only on a line of its own (critic’s review).
  assert.equal(toPlainText('Run ```a**b``` then 10**9.'), 'Run a**b then 10**9.');
  assert.equal(toPlainText('Before\n```js\nx = 2**3\n```\nafter 2*n'), 'Before after 2*n');
  assert.equal(toPlainText('Open\n````\n```\nstill code\n````\nshut'), 'Open shut');
  // A fence in a quote or a nested list item is still a fence, as the renderer reads it once the > and indent go (pre-review).
  assert.equal(toPlainText('> quote\n> ```\n> x**y*z\n> ```\n> after'), 'quote after');
  assert.equal(toPlainText('- a\n  - b\n    ```\n    x*y*z\n    ```\n  - c'), 'a b c');
  assert.equal(toPlainText('1. step\n\n    ```js\n    let a*b*c\n    ```'), 'step');
  // Every private-use character present: it still finds a placeholder the text doesn’t hold, and ends.
  const every = Array.from({ length: 0xf900 - 0xe000 }, (_, k) => String.fromCharCode(0xe000 + k)).join('');
  assert.equal(toPlainText(`${every} 10**9`), `${every} 10**9`);
});

test('a spaced * opens no emphasis, so math after it keeps its stars; a*b*c between letters is still emphasis', async () => {
  const { renderMarkdown } = await import('../shared/markdown.mjs');
  const { toPlainText } = await import('../shared/markdown-plain.mjs');
  const shown = (src) => stripTags(renderMarkdown(src)).replaceAll('&#42;', '*').trim();
  for (const typed of ['5 * 3 = 15, and 2*n*k', 'a ** b, then 10**9 and 10**10']) {
    assert.equal(shown(typed), typed);
    assert.equal(toPlainText(typed), typed);
  }
  // The digit rule: between letters, the stars are emphasis, not math.
  assert.match(renderMarkdown('a*b*c'), /a<em>b<\/em>c/);
  assert.match(renderMarkdown('foo**bar**baz'), /foo<strong>bar<\/strong>baz/);
  // A code span drops one space each side, as the renderer’s does: x<code>y</code>z reads “xyz”.
  assert.equal(toPlainText('x`` y ``z'), 'xyz');
});
