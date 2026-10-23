import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown as md, toPlainText } from '../shared/markdown.mjs';

test('escapes raw HTML instead of rendering it', () => {
  const out = md('Hello <script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<script>'));
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;script&gt;'));
});

test('paragraphs, line breaks, bold, italic, strikethrough and code', () => {
  assert.equal(md('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
  assert.equal(md('**bold** and *italic* and _also_ and ~~gone~~'), '<p><strong>bold</strong> and <em>italic</em> and <em>also</em> and <del>gone</del></p>');
  assert.equal(md('use `a < b`'), '<p>use <code>a &lt; b</code></p>');
  assert.equal(md('snake_case_name stays'), '<p>snake_case_name stays</p>');
});

test('safe links open in a new tab; unsafe links keep only their text', () => {
  assert.equal(md('[docs](https://example.com/a?b=1)'), '<p><a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">docs</a></p>');
  assert.equal(md('[click](javascript:alert(1))'), '<p>click</p>');
  assert.equal(md('[rel](/relative)'), '<p>rel</p>');
  assert.ok(md('see https://arxiv.org/abs/2210.03629.').includes('href="https://arxiv.org/abs/2210.03629"'));
});

test('quotes in link text and URLs can’t break out of attributes', () => {
  const out = md('[x](https://example.com/"onmouseover="alert(1))');
  assert.ok(!/"onmouseover=/.test(out.replace(/&quot;/g, '')) || !out.includes(' onmouseover='));
  assert.ok(!out.includes(' onmouseover="'));
});

test('headings, lists, nested lists and quotes', () => {
  assert.equal(md('# Title'), '<h3>Title</h3>');
  assert.equal(md('### Step 1'), '<h4>Step 1</h4>');
  assert.equal(md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(md('3. c\n4. d'), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(md('- a\n  - a1\n- b'), '<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>');
  assert.equal(md('> quoted'), '<blockquote><p>quoted</p></blockquote>');
  assert.equal(md('---'), '<hr>');
});

test('code fences keep their contents escaped and close while streaming', () => {
  assert.equal(md('```js\nif (a < b) {}\n```'), '<pre class="md-code"><code data-lang="js">if (a &lt; b) {}</code></pre>');
  assert.equal(md('```js\nconst x', { streaming: true }), '<pre class="md-code"><code data-lang="js">const x</code></pre>');
});

test('mermaid fences become diagrams only once closed', () => {
  assert.ok(md('```mermaid\nflowchart LR\nA-->B\n```').startsWith('<figure class="md-mermaid">'));
  assert.ok(md('```mermaid\nflowchart LR', { streaming: true }).startsWith('<pre class="md-code">'));
});

test('math: inline and display, but not prices', () => {
  assert.equal(md('cost $C = n^2$ here'), '<p>cost <span class="md-math">C = n^2</span> here</p>');
  assert.equal(md('$$\nx^2\n$$'), '<div class="md-math" data-display="true">x^2</div>');
  assert.equal(md('from $5 to $6'), '<p>from $5 to $6</p>');
});

test('#147: $$…$$ on one line is display math, alone on its line or inside one, with no stray $', () => {
  const D = (tex) => `<div class="md-math" data-display="true">${tex}</div>`;
  // As the SciFact UAT’s agent wrote it.
  assert.equal(md('$$P = \\frac{|\\hat{R} \\cap R|}{|\\hat{R}|}$$'), D('P = \\frac{|\\hat{R} \\cap R|}{|\\hat{R}|}'));
  assert.equal(md('Precision:\n  $$x^2$$  \nand more.'), `<p>Precision:</p>${D('x^2')}<p>and more.</p>`);
  assert.equal(md('text $$x^2$$ text'), '<p>text <span class="md-math" data-display="true">x^2</span> text</p>');
  assert.equal(md('$$a$$ and $$b$$'), '<p><span class="md-math" data-display="true">a</span> and <span class="md-math" data-display="true">b</span></p>');
  // Unchanged: inline $…$, the block form, and $$ in code or with nothing between.
  assert.equal(md('cost $x$ here'), '<p>cost <span class="md-math">x</span> here</p>');
  assert.equal(md('$$\ny\n$$'), D('y'));
  assert.equal(md('`$$x$$` and\n```\n$$x$$\n```'), '<p><code>$$x$$</code> and</p><pre class="md-code"><code>$$x$$</code></pre>');
  assert.equal(md('$$ $$'), '<p>$$ $$</p>');
  assert.equal(md('a $$ b'), '<p>a $$ b</p>');
});

test('pipe tables', () => {
  const out = md('| Book | n |\n|---|---|\n| Emma | 3 |');
  assert.equal(
    out,
    '<div class="md-table"><table><thead><tr><th>Book</th><th>n</th></tr></thead><tbody><tr><td>Emma</td><td>3</td></tr></tbody></table></div>',
  );
});

test('citation markers only for sources that exist', () => {
  assert.ok(md('ReAct [1] and [2]', { citations: 1, citeId: 'm1' }).includes('<a class="cite" href="#m1-1"'));
  assert.ok(md('ReAct [1] and [2]', { citations: 1, citeId: 'm1' }).includes('and [2]'));
  assert.ok(!md('[1]').includes('class="cite"'));
});

test('term links and glossary auto-links', () => {
  assert.equal(md('[Requirement F3](term:req-f3)'), '<p><span class="term" tabindex="0" data-term="req-f3">Requirement F3</span></p>');
  const out = md('Then Step 7 runs.', { glossary: [{ key: 'step-7', term: 'Step 7' }] });
  assert.equal(out, '<p>Then <span class="term" tabindex="0" data-term="step-7">Step 7</span> runs.</p>');
  assert.equal(md('Step 70 is different.', { glossary: [{ key: 's', term: 'Step 7' }] }), '<p>Step 70 is different.</p>');
});

test('mentions are marked, but not inside emails', () => {
  assert.equal(md('ask @indexer now', { mentions: ['indexer'] }), '<p>ask <span class="mention">@indexer</span> now</p>');
  assert.equal(md('mail a@indexer.com', { mentions: ['indexer'] }), '<p>mail a@indexer.com</p>');
});

test('plain text for announcements', () => {
  assert.equal(toPlainText('**Hi** [there](https://x.y), see `code`.\n\n- one'), 'Hi there, see code. one');
});

test('a URL cut off mid-stream, right after “https://”, renders as text', () => {
  assert.match(md('See https://'), /See https:\/\//);
  assert.match(md('- item https://'), /<li>item https:\/\/<\/li>/);
});

// ── <details>: the one HTML Postbox renders (#71) ─────────────────────────────────────────

test('<details> with a <summary> folds its Markdown away, on one line or several', () => {
  assert.equal(
    md('<details><summary>Answer</summary> It can score at most **50%**.</details>'),
    '<details><summary>Answer</summary><p>It can score at most <strong>50%</strong>.</p></details>',
  );
  assert.equal(
    md('Try it.\n\n<details>\n<summary>Answer</summary>\n\n- one\n- two\n</details>\nAfter'),
    '<p>Try it.</p><details><summary>Answer</summary><ul><li>one</li><li>two</li></ul></details><p>After</p>',
  );
  assert.equal(md('<details>\nNo summary.\n</details>'), '<details><p>No summary.</p></details>');
  assert.equal(md('<details><summary>A</summary>x</details> and after'), '<details><summary>A</summary><p>x</p></details><p>and after</p>');
});

test('<details> nests, and a closing tag in code doesn’t close it', () => {
  assert.equal(
    md('<details><summary>Answer</summary>\nOuter\n<details><summary>Hint</summary>inner</details>\n</details>'),
    '<details><summary>Answer</summary><p>Outer</p><details><summary>Hint</summary><p>inner</p></details></details>',
  );
  assert.equal(
    md('<details><summary>Code</summary>\n```\n</details>\n```\nuse `</details>` here\n</details>'),
    '<details><summary>Code</summary><pre class="md-code"><code>&lt;/details&gt;</code></pre><p>use <code>&lt;/details&gt;</code> here</p></details>',
  );
});

test('<details> or <summary> with attributes, an unclosed tag, or a tag mid-line stays text', () => {
  assert.equal(md('<details open><summary>x</summary>y</details>'), '<p>&lt;details open&gt;&lt;summary&gt;x&lt;/summary&gt;y&lt;/details&gt;</p>');
  assert.equal(
    md('<details><summary class="a">x</summary>y</details>'),
    '<p>&lt;details&gt;&lt;summary class=&quot;a&quot;&gt;x&lt;/summary&gt;y&lt;/details&gt;</p>',
  );
  assert.equal(md('<details><summary>x</summary>never closed'), '<p>&lt;details&gt;&lt;summary&gt;x&lt;/summary&gt;never closed</p>');
  assert.equal(md('<details><summary>x never closed</details>'), '<p>&lt;details&gt;&lt;summary&gt;x never closed&lt;/details&gt;</p>');
  assert.equal(md('See <details>x</details>'), '<p>See &lt;details&gt;x&lt;/details&gt;</p>');
  assert.equal(md('<DETAILS>x</DETAILS>'), '<p>&lt;DETAILS&gt;x&lt;/DETAILS&gt;</p>');
});

test('nothing else inside <details> becomes HTML: scripts and event handlers stay text', () => {
  const out = md(
    '<details><summary><img src=x onerror=alert(1)></summary>\n<script>alert(1)</script>\n<details ontoggle=alert(1)>x\n\n[x](javascript:alert(1))\n</details>',
  );
  assert.ok(out.startsWith('<details><summary>&lt;img src=x onerror=alert(1)&gt;</summary>'));
  assert.ok(!/<(script|img)\b/.test(out));
  assert.ok(!/ on\w+=/.test(out.replace(/&lt;[^&]*&gt;/g, '')));
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && out.includes('&lt;details ontoggle=alert(1)&gt;'));
  assert.ok(!out.includes('javascript:'));
  // Only <details>, <summary> and the Markdown renderer's own tags appear.
  const tags = new Set([...out.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]));
  assert.deepEqual([...tags].sort(), ['br', 'details', 'p', 'summary']);
});

test('plain text drops the <details> and <summary> tags', () => {
  assert.equal(toPlainText('<details><summary>Answer</summary>42</details>'), 'Answer 42');
});

test('a fold right under a list item stays in that item, blank lines and all', () => {
  assert.equal(
    md('1. What is X?\n<details><summary>Answer</summary>\n\nY\n\n</details>\n2. Next'),
    '<ol><li>What is X?<details><summary>Answer</summary><p>Y</p></details></li><li>Next</li></ol>',
  );
});

test('folds: false shows <details> as text, as a review does', () => {
  assert.equal(md('<details><summary>A</summary>x</details>', { folds: false }), '<p>&lt;details&gt;&lt;summary&gt;A&lt;/summary&gt;x&lt;/details&gt;</p>');
});

// ── Emphasis around `code` (#82) ──────────────────────────────────────────────────────────

test('bold around a code span is bold, with no literal ** (#82)', () => {
  assert.equal(
    md('**Add three checks to `rename.py`:** every swapped answer'),
    '<p><strong>Add three checks to <code>rename.py</code>:</strong> every swapped answer</p>',
  );
  assert.equal(md('Run **`eval.py`.** Then'), '<p>Run <strong><code>eval.py</code>.</strong> Then</p>');
  assert.equal(md('**Add checks to rename.py:** text'), '<p><strong>Add checks to rename.py:</strong> text</p>');
});

test('italic around a code span, with * and _ (#82)', () => {
  assert.equal(md('*see `x`*'), '<p><em>see <code>x</code></em></p>');
  assert.equal(md('_see `x`_'), '<p><em>see <code>x</code></em></p>');
});

test('bold around a code span in ordered and unordered list items (#82)', () => {
  assert.equal(
    md('3. **Add three checks to `rename.py`:** every swapped answer'),
    '<ol start="3"><li><strong>Add three checks to <code>rename.py</code>:</strong> every swapped answer</li></ol>',
  );
  assert.equal(md('- **Run `eval.py`** first'), '<ul><li><strong>Run <code>eval.py</code></strong> first</li></ul>');
});

test('asterisks inside a code span stay literal and don’t close emphasis (#82)', () => {
  assert.equal(md('`a ** b`'), '<p><code>a ** b</code></p>');
  assert.equal(md('**x `**` y**'), '<p><strong>x <code>**</code> y</strong></p>');
  assert.equal(md('*a `*` b*'), '<p><em>a <code>*</code> b</em></p>');
});

test('code spans stay escaped, and a NUL in the text can’t stand in for one (#82)', () => {
  assert.equal(md('**`<b>` & `"q"`**'), '<p><strong><code>&lt;b&gt;</code> &amp; <code>&quot;q&quot;</code></strong></p>');
  assert.equal(md('a\0b `c`'), `<p>a${String.fromCodePoint(0xfffd)}b <code>c</code></p>`);
  assert.equal(
    md('`Step 7` and Step 7', { glossary: [{ key: 's', term: 'Step 7' }] }),
    '<p><code>Step 7</code> and <span class="term" tabindex="0" data-term="s">Step 7</span></p>',
  );
});
