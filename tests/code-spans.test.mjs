// #1601: the readers that set code apart without rendering it read only single-backtick spans, so text in a span of two
// backticks, shown as code, counted as prose: a handle there woke its agent, a </details> there closed the disclosure,
// and a term link there was linted. Each now reads spans as the renderer does (shared/code-spans.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintTerms } from '../server/lint.mjs';
import { renderMarkdown } from '../shared/markdown.mjs';
import { toPlainText } from '../shared/markdown-plain.mjs';
import { parseMentions } from '../shared/text.mjs';

test('a handle in code of any backtick run wakes no one, and one in prose still does', () => {
  assert.deepEqual(parseMentions('Run ``@critic`` here', ['critic']), []);
  assert.deepEqual(parseMentions('Run `` a`@critic `` here', ['critic']), []);
  assert.deepEqual(parseMentions('Run `@critic` here', ['critic']), []);
  assert.deepEqual(parseMentions('Run ``a`` then @critic', ['critic']), ['critic']);
  // A run with no close is text, as the page shows it.
  assert.deepEqual(parseMentions('Run `` @critic', ['critic']), ['critic']);
  // A fence opens only on a line of its own: three backticks mid-line are a span.
  assert.deepEqual(parseMentions('Say ```@critic``` then @critic', ['critic']), ['critic']);
  assert.deepEqual(parseMentions('```\n@critic\n```\nand @critic', ['critic']), ['critic']);
  assert.deepEqual(parseMentions('```\n@critic\n```', ['critic']), []);
  // A fence can open on a list item’s own line, as the renderer reads it (pre-review).
  assert.deepEqual(parseMentions('- ```\n  @critic\n  ```\nafter', ['critic']), []);
  assert.deepEqual(parseMentions('1. ```\n   @critic\n   ```', ['critic']), []);
  // A list marker opens a fence but never closes one: `- ~~~` inside a ~~~ fence is code (critic’s review).
  const fenced = '~~~\n- ~~~\n@critic Step 7\n~~~\nafter @critic';
  assert.deepEqual(parseMentions(fenced, ['critic']), ['critic']);
  assert.deepEqual(parseMentions('~~~\n- ~~~\n@critic\n~~~\nafter', ['critic']), []);
  assert.deepEqual(lintTerms(fenced, {}), []);
  assert.equal(toPlainText(fenced), 'after @critic');
});

test('a </details> in code of any backtick run leaves the disclosure open', () => {
  const html = renderMarkdown('<details><summary>Notes</summary>\n\nUse `` a</details>b `` here.\n\nStill inside.\n\n</details>\n\nAfter.');
  assert.match(html, /<details><summary>Notes<\/summary>.*<code>a&lt;\/details&gt;b<\/code>.*Still inside\..*<\/details><p>After\.<\/p>$/s);
});

test('a term link in code of any backtick run isn’t linted, and one in prose still is', () => {
  assert.deepEqual(lintTerms('See ``[x](term:nope)`` here', {}), []);
  assert.deepEqual(lintTerms('- ```\n  Step 7\n  ```', {}), []);
  assert.deepEqual(
    lintTerms('See ``a`` and [x](term:nope)', {}).map((t) => t.key),
    ['nope'],
  );
});
