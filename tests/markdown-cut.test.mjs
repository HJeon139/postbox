// #850: a streaming reply renders what it closed once, and each frame only what follows its cut
// (renderMarkdownCut). Rendered that way, frame by frame, a reply is exactly what rendering it whole gives, at every
// frame, across the cut hazards: an open fence, a list, a table, a quote, a heading, math, a diagram and an
// HTML-looking line, a <details> fold among them.

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../shared/markdown.mjs';
import { renderMarkdownCut } from '../shared/markdown-cut.mjs';

/** The pieces a generated reply is made of, each a run of whole lines. */
const PIECES = [
  'A paragraph of **bold** words and `code`.',
  'One line\nand the next line of the same paragraph.',
  '### A heading',
  '- one\n- two\n- three',
  '- one\n\n- two, after a blank line',
  '1. first\n2. second\n   indented on',
  '- an item\n\n  a paragraph of the item, after a blank line',
  '- an item\nlazily continued',
  '| a | b |\n| --- | --- |\n| 1 | 2 |',
  '> a quote\n> on two lines',
  '> a quote\n\n> and another',
  '```js\nconst x = 1;\n\nconst y = 2;\n```',
  '```mermaid\ngraph LR\n  A --> B\n```',
  '$$\nE = mc^2\n$$',
  '\\[\na^2 + b^2\n\\]',
  '$$E = mc^2$$',
  '<details>\n<summary>The answer</summary>\n\nIt is 42.\n\n</details>',
  '- a question\n  <details><summary>Answer</summary>\n\n  Yes.\n\n  </details>',
  '<div>an HTML-looking line</div>',
  '---',
  'Term BM25 and @critic, cited [1].',
];

/** A small seeded generator, so a failure names the seed that made it. @param {number} seed */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

/** A reply of `n` pieces, each followed by one or two blank lines, or none. @param {() => number} r @param {number} n */
function reply(r, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)] + ['\n\n', '\n\n\n', '\n'][Math.floor(r() * 3)];
  return s;
}

const OPTS = { streaming: true, citations: 1, citeId: 'src-x', glossary: [{ key: 'bm25', term: 'BM25' }], mentions: ['critic'] };

/**
 * Streams `text` in frames of `step` characters as the page does: render after the cut, keep what’s before it.
 * Checks each frame against rendering the whole so far. Returns the characters rendered in all.
 */
function stream(text, step, label) {
  let src = '';
  let head = '';
  let rendered = 0;
  for (let n = step; n < text.length + step; n += step) {
    const now = text.slice(0, Math.min(n, text.length));
    const r = renderMarkdownCut(now.slice(src.length), OPTS);
    rendered += now.length - src.length;
    assert.equal(head + r.head + r.tail, renderMarkdown(now, OPTS), `${label}, at ${now.length} characters`);
    head += r.head;
    src += now.slice(src.length, src.length + r.cut);
    assert.equal(head, renderMarkdown(src, OPTS), `${label}: what’s kept is the kept source rendered, at ${now.length}`);
  }
  return rendered;
}

test('#850 a reply rendered after its cut, frame by frame, is the whole reply rendered, at every frame', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    const text = reply(r, 3 + Math.floor(r() * 10));
    for (const step of [1, 7, 40]) stream(text, step, `seed ${seed}, step ${step}`);
  }
});

test('#850 every piece, alone and around every other, at every character', () => {
  for (const a of PIECES) for (const b of PIECES) stream(`${a}\n\n${b}\n\nAfter.\n\nMore.`, 1, JSON.stringify([a, b]));
});

test('#850 the cut moves on as a reply grows, so each frame renders a bounded tail', () => {
  const text = 'A paragraph of words, long enough to count.\n\n'.repeat(400);
  const rendered = stream(text, 50, 'paragraphs');
  // Rendered whole each frame, it’s about text² / 2step; after the cut, about a paragraph and a frame each time.
  assert.ok(rendered < text.length * 3, `${rendered} characters rendered for ${text.length}`);
});

test('#850 no cut past a <details> or display math still open, and none with positions or a carriage return', () => {
  assert.equal(renderMarkdownCut('<details>\n\nOpen still.\n\nMore.\n\nAnd more.').cut, 0);
  assert.equal(renderMarkdownCut('$$\n\nx\n\nMore.\n\nAnd more.').cut, 0);
  assert.equal(renderMarkdownCut('One.\n\nTwo.\n\nThree.', { positions: true }).cut, 0);
  assert.equal(renderMarkdownCut('One.\r\n\r\nTwo.\r\n\r\nThree.').cut, 0);
  // The last line may still be growing, so the cut is before the line ahead of it.
  assert.equal(renderMarkdownCut('One.\n\nTwo.\n\nThree.').cut, 'One.\n\n'.length);
  assert.equal(renderMarkdownCut('One.\n\nTwo.\n\nThree.\n').cut, 'One.\n\nTwo.\n\n'.length);
});
