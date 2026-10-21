import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('pipe tables', () => {
  const out = md('| Book | n |\n|---|---|\n| Emma | 3 |');
  assert.equal(out, '<div class="md-table"><table><thead><tr><th>Book</th><th>n</th></tr></thead><tbody><tr><td>Emma</td><td>3</td></tr></tbody></table></div>');
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
