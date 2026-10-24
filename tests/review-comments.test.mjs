import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepReviewThreads } from '../server/review-comments.mjs';
import { renderMarkdown } from '../shared/markdown.mjs';
import { anchorOf, commentAt, commentErrors, quoteOf, toSource, toText } from '../shared/review-comments.mjs';

/** The runs a render with positions marks, in order: the text each shows, and the source line and offsets it names. */
function runsOf(html) {
  const runs = [];
  const open = /<span data-sl="(\d+)" data-sc="(\d+)" data-se="(\d+)">/g;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    // Its end is the </span> that closes it, past any spans inside it (a mention, a term, math).
    let depth = 1;
    let k = open.lastIndex;
    const tag = /<span\b|<\/span>/g;
    tag.lastIndex = k;
    for (let t = tag.exec(html); t; t = tag.exec(html)) {
      depth += t[0] === '</span>' ? -1 : 1;
      if (depth === 0) {
        k = t.index;
        break;
      }
    }
    const text = html
      .slice(open.lastIndex, k)
      .replace(/<[^>]+>/g, '')
      .replace(/&(lt|gt|quot|#39|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[e]);
    runs.push({ n: +m[1], sc: +m[2], se: +m[3], text });
    open.lastIndex = k;
  }
  return runs;
}

/**
 * What selecting `picked` in the rendered draft comments on: the browser maps each end of a selection through the run
 * it’s in the same way (app/js/review-preview.mjs). nth picks a later match.
 */
function select(src, picked, nth = 0) {
  const lines = src.split('\n');
  const runs = runsOf(renderMarkdown(src, { positions: true, folds: false }));
  const all = runs.map((r) => r.text).join('');
  let at = -1;
  for (let i = 0; i <= nth; i++) at = all.indexOf(picked, at + 1);
  assert.ok(at > -1, `“${picked}” isn’t in the rendered text “${all}”`);
  const point = (k, side) => {
    let before = 0;
    for (const r of runs) {
      const inside = side === 'start' ? k < before + r.text.length : k <= before + r.text.length;
      if (inside) return { n: r.n, c: r.sc + toSource(r.text, lines[r.n - 1].slice(r.sc, r.se), k - before, side) };
      before += r.text.length;
    }
    throw new Error(`No run holds offset ${k}`);
  };
  return anchorOf(lines, point(at, 'start'), point(at + picked.length, 'end'));
}

test('#179: a selection in a paragraph is its line, columns and the source it quotes', () => {
  assert.deepEqual(select('Intro line.\nHello world, this is plain.', 'world'), { line: 2, col: 7, endLine: 2, endCol: 11, quote: 'world' });
  // Across the two lines of one paragraph.
  assert.deepEqual(select('One two\nthree four', 'two\nthree'.replace('\n', '')), { line: 1, col: 5, endLine: 2, endCol: 5, quote: 'two\nthree' });
});

test('#179: inside bold, the columns are the text’s own, and across its end the quote keeps the marks', () => {
  assert.deepEqual(select('Make it **really bold** now', 'really'), { line: 1, col: 11, endLine: 1, endCol: 16, quote: 'really' });
  assert.deepEqual(select('Make it **really bold** now', 'bold now'), { line: 1, col: 18, endLine: 1, endCol: 27, quote: 'bold** now' });
});

test('#179: a link’s text maps to its label, not its address', () => {
  assert.deepEqual(select('See [the docs](https://example.com/docs) today', 'the docs'), { line: 1, col: 6, endLine: 1, endCol: 13, quote: 'the docs' });
  // Text right after a link isn’t matched inside its address.
  assert.deepEqual(select('[a](https://b.example)b', 'b'), { line: 1, col: 23, endLine: 1, endCol: 23, quote: 'b' });
});

test('#179: inline code maps inside its ticks', () => {
  assert.deepEqual(select('Run `npm test` first', 'npm test'), { line: 1, col: 6, endLine: 1, endCol: 13, quote: 'npm test' });
  assert.deepEqual(select('Run `npm test` first', 'test first'), { line: 1, col: 10, endLine: 1, endCol: 20, quote: 'test` first' });
});

test('#179: escapes and entities: the source keeps its backslash, and an entity is its own text', () => {
  assert.deepEqual(select('A snake\\_case\\_name', 'case_name'), { line: 1, col: 10, endLine: 1, endCol: 19, quote: 'case\\_name' });
  assert.deepEqual(select('Fish &amp; chips <b>', '&amp; chips <b>'), { line: 1, col: 6, endLine: 1, endCol: 20, quote: '&amp; chips <b>' });
});

test('#179: a list item, a nested item, a lazy line and a quote are mapped past their markers', () => {
  assert.deepEqual(select('- first item\n- second **item** here', 'second item'), { line: 2, col: 3, endLine: 2, endCol: 15, quote: 'second **item' });
  assert.deepEqual(select('1. a\n   - nested b', 'nested'), { line: 2, col: 6, endLine: 2, endCol: 11, quote: 'nested' });
  assert.deepEqual(select('- item\ncontinued here', 'continued'), { line: 2, col: 1, endLine: 2, endCol: 9, quote: 'continued' });
  assert.deepEqual(select('> quoted *text*\n> > deeper', 'deeper'), { line: 2, col: 5, endLine: 2, endCol: 10, quote: 'deeper' });
  assert.deepEqual(select('## Title here', 'Title'), { line: 1, col: 4, endLine: 1, endCol: 8, quote: 'Title' });
});

test('#179: a table cell is its row, with the cell’s columns', () => {
  const src = '| Name | Cost |\n|---|---|\n| Alpha | low price |\n| B \\| C | high |';
  assert.deepEqual(select(src, 'low price'), { line: 3, col: 11, endLine: 3, endCol: 19, quote: 'low price' });
  assert.deepEqual(select(src, 'Cost'), { line: 1, col: 10, endLine: 1, endCol: 13, quote: 'Cost' });
  // A cell after an escaped pipe keeps its place.
  assert.deepEqual(select(src, 'high'), { line: 4, col: 12, endLine: 4, endCol: 15, quote: 'high' });
});

test('#179: diagrams, math and code fences are marked whole, by their lines', () => {
  const html = renderMarkdown('Intro\n\n```mermaid\ngraph TD\nA-->B\n```\n\n$$\nx^2\n$$\n\n```js\nlet a;\n```', { positions: true });
  assert.match(html, /<figure class="md-mermaid" data-sl="3" data-el="6">/);
  assert.match(html, /<div class="md-math" data-display="true" data-sl="8" data-el="10">/);
  assert.match(html, /<pre class="md-code" data-sl="12" data-el="14">/);
});

test('#179: without positions, the render is what it was before them', () => {
  // The expected HTML is what shared/markdown.mjs on main (84ae4c8) renders for this draft.
  const src =
    '# T\n\nPara **b** [l](https://x.y) `c` $x$ @al\nnext line\n\n- a **b**\n  - nested\n1. one\n\n> q *i*\n\n| x | y \\| z |\n|---|---|\n| `a\\|b` | c |\n\n```mermaid\ngraph TD\n```\n\n$$\nE\n$$\n\n```js\nlet a;\n```';
  assert.equal(
    renderMarkdown(src, { mentions: ['al'] }),
    '<h3>T</h3><p>Para <strong>b</strong> <a href="https://x.y" target="_blank" rel="noopener noreferrer">l</a> <code>c</code> <span class="md-math">x</span> <span class="mention">@al</span><br>next line</p><ul><li>a <strong>b</strong><ul><li>nested</li></ul></li><li>one</li></ul><blockquote><p>q <em>i</em></p></blockquote><div class="md-table"><table><thead><tr><th>x</th><th>y | z</th></tr></thead><tbody><tr><td><code>a|b</code></td><td>c</td></tr></tbody></table></div><figure class="md-mermaid"><pre><code>graph TD</code></pre></figure><div class="md-math" data-display="true">E</div><pre class="md-code"><code data-lang="js">let a;</code></pre>',
  );
  // With positions, the same HTML once its marks are taken off; a code span in a table cell still shows its pipe.
  const stack = [];
  const unmarked = renderMarkdown(src, { mentions: ['al'], positions: true })
    .replace(/ data-(?:sl|el)="\d+"/g, '')
    .replace(/<span\b[^>]*>|<\/span>/g, (tag) => {
      // A run’s span goes, with the </span> that closes it; any other span stays.
      if (tag === '</span>') return stack.pop() ? '' : tag;
      const run = tag.includes('data-sc=');
      stack.push(run);
      return run ? '' : tag;
    });
  assert.equal(unmarked, renderMarkdown(src, { mentions: ['al'] }));
});

test('#179: an end at a line’s edge moves inside the text, and a long quote is cut', () => {
  const lines = ['First para.', '', 'Second.'];
  // From the end of line 1 to the start of line 3: nothing but the break between them.
  assert.equal(anchorOf(lines, { n: 1, c: 11 }, { n: 3, c: 0 }), null);
  assert.deepEqual(anchorOf(lines, { n: 1, c: 6 }, { n: 3, c: 0 }), { line: 1, col: 7, endLine: 1, endCol: 11, quote: 'para.' });
  const long = ['x'.repeat(2500)];
  const a = anchorOf(long, { n: 1, c: 0 }, { n: 1, c: 2500 });
  assert.equal(a?.quote.length, 2000);
  assert.equal(a?.endCol, 2000);
  assert.equal(quoteOf(['abc', 'def'], { line: 1, col: 2, endLine: 2, endCol: 1 }), 'bc\nd');
});

test('#179: toText is toSource’s inverse, and drawn math snaps to its edges', () => {
  assert.equal(toText('bold now', '**bold** now', toSource('bold now', '**bold** now', 4, 'end'), 'end'), 4);
  assert.equal(toSource('x² + 1', '$x^2+1$', 2, 'start'), 0);
  assert.equal(toSource('x² + 1', '$x^2+1$', 2, 'end'), 7);
});

test('one comment shape: a line, a selection, an app part or a thread, with what’s wrong said', () => {
  assert.deepEqual(commentErrors({ line: 3, text: 'Too long.' }, 'comments[0]'), []);
  assert.deepEqual(commentErrors({ line: 3, col: 5, endLine: 3, endCol: 9, quote: 'words', text: 'Cut.' }, 'c'), []);
  assert.deepEqual(commentErrors({ anchor: 'filters', text: 'Hm.' }, 'c'), []);
  assert.deepEqual(commentErrors({ line: 3, col: 5, text: 'Cut.' }, 'c'), ['c: a comment on a selection needs line, col, endLine, endCol and quote.']);
  assert.deepEqual(commentErrors({ line: 3, col: 9, endLine: 3, endCol: 5, quote: 'x', text: 'Cut.' }, 'c'), [
    'c: a selection’s end (endLine, endCol) comes after its start (line, col).',
  ]);
  assert.deepEqual(commentErrors({ text: 'Where?' }, 'c'), ['c needs a line, an anchor or a thread.']);
  assert.deepEqual(commentErrors({ line: 1, text: '  ' }, 'c'), ['c.text is empty.']);
  assert.deepEqual(commentErrors({ line: 1, text: 'x', author: 'me' }, 'c'), ['c has an unknown field “author”.']);
  assert.deepEqual(commentErrors({ line: 1, text: 'x'.repeat(4001) }, 'c'), ['c.text is longer than 4,000 characters.']);
  // A name every object inherits isn’t a field.
  assert.deepEqual(commentErrors({ line: 1, text: 'x', constructor: 5 }, 'c'), ['c has an unknown field “constructor”.']);
  assert.deepEqual(commentErrors(JSON.parse('{"line":1,"text":"x","__proto__":1}'), 'c'), ['c has an unknown field “__proto__”.']);
});

test('#179: what the agent reads: line, columns and the quote', () => {
  assert.equal(commentAt({ line: 12, col: 5, endLine: 12, endCol: 23, quote: 'the quoted text' }), 'line 12, col 5–23 “the quoted text”');
  assert.equal(commentAt({ line: 2, col: 5, endLine: 3, endCol: 1, quote: 'two\nt' }), 'line 2, col 5 to line 3, col 1 “two\nt”');
  assert.equal(commentAt({ line: 4 }), 'line 4');
  assert.equal(commentAt({ anchor: 'filters' }), '“filters”');
});

// Review of #255’s fix: a reviewer who only replied in the person’s thread doesn’t lock it; their words stay.
test('#133: in the person’s thread a reviewer replied in, the agent adds comments and moves it, but keeps every word', () => {
  const c1 = {
    id: 'c1',
    line: 1,
    status: 'open',
    comments: [
      { author: 'You', text: 'Too long.' },
      { author: '@critic', text: 'Agreed.' },
    ],
  };
  const existing = { handle: 'researcher', reviews: [{ handle: 'critic', threads: ['c1'] }], block: { content: 'a\nb', threads: [c1] } };
  const sent = [
    { author: 'You', text: 'Too long.' },
    { author: '@critic', text: 'Ship it.' },
    { author: 'You', text: 'Cut it.' },
    { author: '@researcher', text: 'Cut.' },
  ];
  const out = keepReviewThreads(existing, { content: 'a\nb', threads: [{ ...c1, line: 2, status: 'resolved', comments: sent }] });
  assert.deepEqual(out.threads, [{ ...c1, line: 2, status: 'resolved', comments: [...c1.comments, sent[2], sent[3]] }]);
});
