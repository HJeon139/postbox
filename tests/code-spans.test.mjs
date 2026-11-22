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

test('a span never crosses a line, as the renderer reads it: a stray run leaves a later mention and term link live', () => {
  // The integrator’s probe on #1602: each of these shows @critic as a mention on the page, so it must wake critic.
  for (const text of [
    'Use ``x here.\n\nThen @critic and ``y``',
    'Ask ``x here\n\n@critic please review ``this``',
    'Note `` x\n\n@critic, check ``done``',
    'Use `x here.\n\nThen @critic and `y`',
  ]) {
    assert.match(renderMarkdown(text, { mentions: ['critic'] }), /class="mention"/, text);
    assert.deepEqual(parseMentions(text, ['critic']), ['critic'], text);
  }
  assert.deepEqual(lintTerms('See ``a\n\n[x](term:nope) and ``b``', {}), [{ term: 'x', key: 'nope' }]);
  assert.equal(toPlainText('Use `x here.\n\nThen *y* and `z`'), 'Use `x here. Then y and z');
});

test('a lone carriage return ends a line for spans too, as the renderer reads it (pre-review)', () => {
  const text = 'a `x\r@critic y`';
  assert.match(renderMarkdown(text, { mentions: ['critic'] }), /class="mention"/);
  assert.deepEqual(parseMentions(text, ['critic']), ['critic']);
  assert.deepEqual(parseMentions('a `x\r\n@critic y`', ['critic']), ['critic']);
});

test('a long line of runs with no close renders in linear time (pre-review)', () => {
  let line = '';
  for (let n = 600; n > 0; n--) line += `${'`'.repeat(n)}a`;
  const t = performance.now();
  renderMarkdown(line);
  assert.ok(performance.now() - t < 500, `rendered ${line.length} characters in ${Math.round(performance.now() - t)} ms`);
});
