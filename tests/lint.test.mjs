import assert from 'node:assert/strict';
import { test } from 'node:test';
import { britishWords, checkMarkdown, checkJs as copyJs, straightQuotes, threadWords } from '../tools/lint-copy.mjs';
import { checkJs as domJs } from '../tools/lint-dom.mjs';
import { codeOnly, scan } from '../tools/lint-lib.mjs';
import { checkCss, checkJs as tokensJs } from '../tools/lint-tokens.mjs';

test('the scanner tells strings, templates, regexes and comments from code', () => {
  const src = 'const a = "x" / 2; // note\nconst r = /a\\/b[/]c/g.test(s) ? `t ${ {a: 1}.a } u` : 1 / 3;';
  assert.deepEqual(
    scan(src).map((t) => [t.kind, t.text, t.line]),
    [
      ['string', 'x', 1],
      ['comment', '// note', 1],
      ['regex', 'a\\/b[/]c', 2],
      ['template', 't ', 2],
      ['template', ' u', 2],
    ],
  );
  assert.equal(codeOnly('f("a<b") // c'), 'f("   ")     ');
});

test('a regex after return is a regex, and after a value is division', () => {
  assert.equal(scan('return /x/.test(s)')[0].kind, 'regex');
  assert.equal(scan('const n = a / b / c;').length, 0);
});

test('lint-tokens: raw colors only inside :root token blocks', () => {
  const css =
    ':root { --a: #fff; }\n@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --a: #000; } }\n.x { color: #123456; }\n.y { color: var(--a); }\n/* #abc in a comment */';
  assert.deepEqual(
    checkCss(css, 'a.css').map((f) => f.line),
    [3],
  );
  assert.equal(tokensJs("el.style.color = '#ff0000';", 'a.js').length, 1);
  assert.equal(tokensJs("// lint-allow tokens: a favicon\nconst c = '#ff0000';", 'a.js').length, 0);
  assert.equal(tokensJs("const c = 'var(--accent)';", 'a.js').length, 0);
});

test('lint-tokens: an exception needs a reason', () => {
  assert.equal(tokensJs("const c = '#ff0000'; // lint-allow tokens:", 'a.js').length, 1);
});

test('lint-dom: HTML parsing, dynamic attribute names and styles are flagged', () => {
  const bad = [
    'el.innerHTML = text;',
    'el.insertAdjacentHTML("beforeend", s);',
    'el.setAttribute(name, v);',
    'el.style[prop] = v;',
    'eval(code);',
    'f.srcdoc = html;',
  ];
  for (const line of bad) assert.equal(domJs(line, 'a.js').length, 1, line);
  const ok = [
    'el.setAttribute("role", "img");',
    'el.textContent = text;',
    'el.style.setProperty("--pct", v);',
    '// el.innerHTML = x in a comment',
    'const s = "el.innerHTML = x";',
  ];
  for (const line of ok) assert.equal(domJs(line, 'a.js').length, 0, line);
  assert.equal(domJs('el.innerHTML = md; // lint-allow dom: renderMarkdown() output', 'a.js').length, 0);
});

test('lint-dom: new-tab links need noopener', () => {
  assert.equal(domJs('const a = `<a href="${u}" target="_blank">x</a>`;', 'a.js').length, 1);
  assert.equal(domJs('const a = `<a href="${u}" target="_blank" rel="noopener">x</a>`;', 'a.js').length, 0);
});

test('lint-copy: British spellings, but not American words that look alike', () => {
  assert.deepEqual(britishWords('The colour of the catalogue was cancelled; organise, analyse, centre.'), [
    'colour',
    'catalogue',
    'cancelled',
    'organise',
    'analyse',
    'centre',
  ]);
  assert.deepEqual(britishWords('Color, catalog, canceled, called, filled, scrolled, analysis, analyses, emphasis, summaries, four hours.'), []);
});

test('lint-copy: straight quotes in prose, but not in code-like strings', () => {
  assert.deepEqual(straightQuotes("You don't have access."), ["don't"]);
  assert.deepEqual(straightQuotes('Press "Show the raw block" to see it.'), ['"Show the raw block"']);
  assert.deepEqual(straightQuotes('<a href="x" target="_blank">'), []);
  assert.equal(copyJs("const s = `Isn't it`;", 'a.js').length, 1);
  assert.equal(copyJs('const sel = \'[data-id="x"]\';', 'a.js').length, 0);
  assert.equal(copyJs('const s = `Call <code>lookup("Emma")</code> first.`;', 'a.js').length, 0);
});

test('lint-copy: “thread” in the shell says it’s a topic or side thread, or it’s a conversation (#4)', () => {
  assert.deepEqual(threadWords('Join this thread'), ['thread']);
  assert.deepEqual(threadWords('Keeps the threads read-only'), ['threads']);
  assert.deepEqual(threadWords('No topic threads yet. Side thread from Planning. Reply in thread.'), []);
  assert.deepEqual(threadWords('Threads'), []);
  assert.equal(copyJs("const a = h('a.btn', 'Open thread');", 'app/js/shell.mjs').length, 1);
  assert.equal(copyJs("const a = h('a.btn', 'Open conversation');", 'app/js/shell.mjs').length, 0);
  // Names and selectors aren’t text people read; other files aren’t checked.
  assert.equal(copyJs("if (ch.type === 'thread') el.querySelector('a.row[data-thread]');", 'app/js/shell.mjs').length, 0);
  assert.equal(copyJs("const a = h('b', 'Close thread');", 'app/js/thread.mjs').length, 0);
  assert.equal(copyJs("const a = plural(n, 'thread');", 'app/js/sheets.mjs').length, 1);
  assert.equal(copyJs("const a = plural(n, 'topic thread');", 'app/js/sheets.mjs').length, 0);
  assert.deepEqual(threadWords('Threads off this conversation'), ['Threads']);
});

test('lint-copy: what agents read says “conversation” for one, too (#75)', () => {
  const said = 'Show a block in the thread.';
  assert.equal(copyJs(`const d = '${said}';`, 'server/mcp.mjs').length, 1);
  assert.equal(copyJs(`const d = '${said.replace('thread', 'conversation')}';`, 'server/mcp.mjs').length, 0);
  // The guide is one long template: a finding points at its own line, and a review’s “threads?” field is a name.
  const guide = 'const g = `## Blocks\n- review: content, previous?, threads?, language?\nThis thread belongs to the project.`;';
  assert.deepEqual(
    copyJs(guide, 'server/adapters/guide.mjs').map((f) => f.line),
    [3],
  );
  // Its straight quotes mark literal values, and stay allowed; spelling is still checked.
  const allowQuotes = '// lint-allow-file quotes: literal values.\n';
  assert.equal(copyJs(`${allowQuotes}const g = \`Use "chips" here.\`;`, 'server/adapters/guide.mjs').length, 0);
  assert.equal(copyJs(`${allowQuotes}const g = \`The colour.\`;`, 'server/adapters/guide.mjs').length, 1);
});

test('lint-copy: docs are checked for spelling outside code', () => {
  assert.equal(checkMarkdown('The colour.\n\n```\ncolour\n```\n`colour`', 'a.md').length, 1);
});
