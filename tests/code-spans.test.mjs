// #1601: the readers that set code apart without rendering it read only single-backtick spans, so text in a span of two
// backticks, shown as code, counted as prose: a handle there woke its agent, a </details> there closed the disclosure,
// and a term link there was linted. Each now reads spans as the renderer does (shared/code-spans.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clip } from '../server/helpers.mjs';
import { lintTerms } from '../server/lint.mjs';
import { renderMarkdown } from '../shared/markdown.mjs';
import { toPlainText } from '../shared/markdown-plain.mjs';
import { parseMentions, spokenSentences } from '../shared/text.mjs';

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
  // A fence can open on a list item’s own line, as the renderer reads it (#1601).
  assert.deepEqual(parseMentions('- ```\n  @critic\n  ```\nafter', ['critic']), []);
  assert.deepEqual(parseMentions('1. ```\n   @critic\n   ```', ['critic']), []);
  // A list marker opens a fence but never closes one: `- ~~~` inside a ~~~ fence is code (#1601).
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

test('a lone carriage return ends a line for spans too, as the renderer reads it', () => {
  const text = 'a `x\r@critic y`';
  assert.match(renderMarkdown(text, { mentions: ['critic'] }), /class="mention"/);
  assert.deepEqual(parseMentions(text, ['critic']), ['critic']);
  assert.deepEqual(parseMentions('a `x\r\n@critic y`', ['critic']), ['critic']);
  // A fence's lines end at a lone \r too, so a mention inside it is code, as the page shows it.
  const fenced = '```\r@critic\r```\rafter';
  assert.doesNotMatch(renderMarkdown(fenced, { mentions: ['critic'] }), /class="mention"/);
  assert.deepEqual(parseMentions(fenced, ['critic']), []);
  assert.deepEqual(parseMentions('hi\r> @critic', ['critic']), []);
});

test('a long line of runs with no close renders in linear time', () => {
  let line = '';
  for (let n = 600; n > 0; n--) line += `${'`'.repeat(n)}a`;
  const t = performance.now();
  renderMarkdown(line);
  assert.ok(performance.now() - t < 100, `rendered ${line.length} characters in ${Math.round(performance.now() - t)} ms`);
});

// #1673: plain text kept a code span’s asterisks but read its underscores as emphasis, so a wake reason said
// “001pagessearch.sql” where the reply had `001_pages_search.sql`. A span’s code is kept as the page shows it.
test('plain text keeps a code span’s code as typed, and still drops emphasis outside it', () => {
  assert.equal(toPlainText('see `001_pages_search.sql`'), 'see 001_pages_search.sql');
  assert.equal(toPlainText('as `001_pages_search.sql`. And `a_b_c`'), 'as 001_pages_search.sql. And a_b_c');
  assert.equal(toPlainText('`__init__` and ``x_y_z`` and `~~gone~~` and `[a](b)`'), '__init__ and x_y_z and ~~gone~~ and [a](b)');
  assert.equal(toPlainText('`a*b*c` and *em*'), 'a*b*c and em');
  assert.equal(toPlainText('**bold** and _em_ then `x_y_z` and __strong__'), 'bold and em then x_y_z and strong');
  // Emphasis can’t pair across a span: the underscores of `a_b` don’t close the one before it.
  assert.equal(toPlainText('_one `a_b` two_'), 'one a_b two');
});

test('plain text keeps code and math asterisks when the text holds every private-use character', () => {
  let every = '';
  for (let code = 0xe000; code <= 0xf8ff; code++) every += String.fromCharCode(code);
  assert.equal(toPlainText(`${every} \`a_b*c\` 2*n *em*`), `${every} a_b*c 2*n em`);
});

test('plain text reads a span on its own line, as the renderer does, at a line feed, CRLF or a lone CR', () => {
  for (const br of ['\n', '\r\n', '\r']) {
    assert.equal(toPlainText(`a \`x${br}\`b_c_d\``), 'a `x b_c_d', JSON.stringify(br));
  }
});

test('wake reasons and excerpts (clip) and spoken sentences keep a code span’s underscores', () => {
  assert.equal(clip('Wrote `001_pages_search.sql` for review'), 'Wrote 001_pages_search.sql for review');
  assert.deepEqual(spokenSentences('Run `001_pages_search.sql` now. ', 0, true).sentences, ['Run 001_pages_search.sql now.']);
});

test('plain text of a long text full of spans and stray runs takes linear time', () => {
  const spans = '`a_b*c` _d_ '.repeat(20_000);
  let stray = '';
  for (let n = 600; n > 0; n--) stray += `${'`'.repeat(n)}a_`;
  for (const text of [spans, stray]) {
    const t = performance.now();
    toPlainText(text);
    const ms = performance.now() - t;
    assert.ok(ms < 200, `cut ${text.length} characters to plain text in ${Math.round(ms)} ms`);
  }
});
