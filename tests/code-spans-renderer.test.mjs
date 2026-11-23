// #1659: the readers that set code apart without rendering it read spans as the renderer does: an escaped backtick is
// text, a table row's cells are read one by one, and the callers that paired backticks themselves (the raw-HTML lint,
// write intent, room links) use the same reader. Each case compares the reader's spans with the <code> elements
// renderMarkdown draws for the same text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rawHtmlProblems } from '../server/checks.mjs';
import { codeSpansIn, mapCodeSpans } from '../shared/code-spans.mjs';
import { renderMarkdown } from '../shared/markdown.mjs';
import { parseMentions } from '../shared/text.mjs';

/** The code the page draws, in order: each <code> element's text, entities read back. */
const drawn = (md) =>
  [...renderMarkdown(md).matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) =>
    m[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&'),
  );

const CASES = [
  ['an escaped backtick, which is text', 'see \\`@bob\\` now'],
  ['an escaped backtick before a later run', '\\`@critic` and ``` more'],
  ['an escaped backslash, then a real span', 'a \\\\`code` b'],
  ['a span split across table cells, which is no span', '| h | i |\n|---|---|\n| `a | @bob b` |'],
  ['a span inside one table cell', '| h | i |\n|---|---|\n| `a` | b |'],
  ['an escaped pipe inside a cell’s span', '| h |\n|---|\n| `a \\| b` |'],
  ['a plain line, as before', 'run `npm test` and ``a ` b`` then'],
];

for (const [name, md] of CASES)
  test(`#1659 the reader finds the code the page draws: ${name}`, () => {
    assert.deepEqual(
      codeSpansIn(md).map((c) => c.replace(/\\\|/g, '|')),
      drawn(md),
    );
  });

test('#1659 a mention the page shows as prose is heard', () => {
  assert.deepEqual(parseMentions('see \\`@bob\\` now', ['bob']), ['bob']);
  assert.deepEqual(parseMentions('| h | i |\n|---|---|\n| `a | @bob b` |', ['bob']), ['bob']);
});

test('#1659 the raw-HTML lint reads spans as the page does', () => {
  // A stray backtick doesn't make the next line's tag code.
  assert.deepEqual(
    rawHtmlProblems('a ` stray\n<div> here `').map((p) => p.message.includes('<div>')),
    [true],
  );
  // A tag inside a double-backtick span is code, though a single backtick sits inside it.
  assert.deepEqual(rawHtmlProblems('`` x ` <div> ` y``'), []);
});

test('#1659 mapCodeSpans keeps the text outside spans as it was', () => {
  const md = '| h | i |\n|---|---|\n| `a` | b \\` c |';
  assert.equal(
    mapCodeSpans(md, (code) => `[${code}]`),
    '| h | i |\n|---|---|\n| [a] | b \\` c |',
  );
});
