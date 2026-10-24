import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../shared/markdown.mjs';
import { groupReviewLines } from '../shared/review-lines.mjs';

const rowsOf = (src) => src.split('\n').map((t, i) => ({ t, kind: /** @type {const} */ ('same'), n: i + 1 }));
const group = (src) => groupReviewLines(rowsOf(src));
// Each group as its type and the lines of its targets, e.g. "table 1,3,4".
const shape = (groups) =>
  groups.map((g) => `${g.type}${g.depth ? `>${g.depth}` : ''} ${(g.type === 'line' ? [g.unit] : g.units).map((u) => u.key ?? 'x').join(',')}`);

test('a table is one group with a target per row, and the delimiter row has none', () => {
  const groups = group('## Options\n\n| Option | Cost |\n|---|---|\n| A | low |\n| B | high |\nAfter.');
  assert.deepEqual(shape(groups), ['line 1', 'line 2', 'table 3,5,6', 'line 7']);
  const t = groups[2];
  assert.equal(t.type, 'table');
  if (t.type !== 'table') return;
  assert.deepEqual(
    t.hidden.map((r) => r.n),
    [4],
  );
  // The source renders as one table, with a <tr> for each target, in order.
  const html = renderMarkdown(t.source);
  assert.equal(html.match(/<tr>/g)?.length, t.units.length);
  assert.ok(html.includes('<th>Option</th>') && html.includes('<td>high</td>'));
});

test('a row of dashes after the delimiter is content, as renderMarkdown draws it', () => {
  const [t] = group('| a |\n|---|\n|---|');
  assert.equal(t.type, 'table');
  if (t.type === 'table') assert.deepEqual(shape([t]), ['table 1,3']);
});

test('a fence is a group of code lines; its markers are hidden', () => {
  const groups = group('Before\n```js\nconst a = 1;\n\nconst b = 2;\n```\nAfter');
  assert.deepEqual(shape(groups), ['line 1', 'code 3,4,5', 'line 7']);
  const g = groups[1];
  if (g.type !== 'code') return assert.fail('expected a code group');
  assert.equal(g.lang, 'js');
  assert.deepEqual(
    g.hidden.map((r) => r.n),
    [2, 6],
  );
});

test('an unclosed fence runs to the end, as in renderMarkdown; a list or table inside it stays code', () => {
  assert.deepEqual(shape(group('```\n- not a list\n| a |\n|---|')), ['code 2,3,4']);
  assert.deepEqual(shape(group('$$\nx^2\n$$\n- item')), ['code 2', 'list 4']);
});

test('#137: [ and ] on lines of their own are a math group, as $$ is; a [ never closed stays a line', () => {
  const groups = group('A\n\\[\nx = 1\n\\]\nB');
  assert.deepEqual(shape(groups), ['line 1', 'code 3', 'line 5']);
  const m = groups[1];
  assert.ok(m.type === 'code' && m.lang === 'math');
  if (m.type !== 'code') return;
  assert.deepEqual(
    m.hidden.map((r) => r.t),
    ['\\[', '\\]'],
  );
  // As renderMarkdown draws it: without its \], \[ is an escaped bracket on a line of its own.
  assert.deepEqual(shape(group('A\n\\[\nno close')), ['line 1', 'line 2', 'line 3']);
  assert.deepEqual(shape(group('$$\nx')), ['code 2'], 'an unclosed $$ runs to the end, as before');
});

test('a list is one group with a target per item; continuation lines belong to their item', () => {
  const groups = group('- one\n  more of one\n- two\n  - nested\n\n- three\nlazy line\n\nAfter');
  assert.deepEqual(shape(groups), ['list 1,3,4,6', 'line 8', 'line 9']);
  const g = groups[0];
  if (g.type !== 'list') return assert.fail('expected a list group');
  assert.deepEqual(
    g.units.map((u) => u.lines),
    [[1, 2], [3], [4, 5], [6, 7]],
  );
  // One <li> per target, in document order.
  assert.equal(renderMarkdown(g.source).match(/<li>/g)?.length, g.units.length);
});

test('ordered lists keep their numbering, because the list renders whole', () => {
  const [g] = group('3. three\n4. four');
  if (g.type !== 'list') return assert.fail('expected a list group');
  assert.match(renderMarkdown(g.source), /^<ol start="3"><li>three<\/li><li>four<\/li><\/ol>$/);
});

test('a rule made of list markers is a rule, not a list', () => {
  assert.deepEqual(shape(group('- - -\n* * *')), ['line 1', 'line 2']);
});

test('a quote’s lines are grouped like any others, one level deeper', () => {
  const groups = group('> Quoted\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n>\n> > deeper\nOut');
  assert.deepEqual(shape(groups), ['line>1 1', 'table>1 2,4', 'line>1 5', 'line>2 6', 'line 7']);
  const t = groups[1];
  if (t.type === 'table') assert.equal(t.source, '| a | b |\n|---|---|\n| 1 | 2 |');
  if (groups[3].type === 'line') assert.equal(groups[3].unit.rows[0].t, 'deeper');
});

test('headings, rules and paragraph lines stay one target each', () => {
  assert.deepEqual(shape(group('# Title\nline one\nline two\n---\n# a | b\n|---|')), ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6']);
});

// ── Diffs ──────────────────────────────────────────────────────────────────────────────

// Rows as diffLines in shared/review-diff.mjs returns them: each line prefixed ' ' (same), '-' or '+'.
const diff = (...lines) => {
  let o = 0,
    n = 0;
  return groupReviewLines(
    lines.map((l) => {
      const t = l.slice(1);
      if (l[0] === '-') return { t, kind: /** @type {const} */ ('del'), o: ++o };
      if (l[0] === '+') return { t, kind: /** @type {const} */ ('add'), n: ++n };
      return { t, kind: /** @type {const} */ ('same'), n: ++n, o: ++o };
    }),
  );
};
const kinds = (g) => (g.type === 'line' ? [g.unit] : g.units).map((u) => `${u.kind}:${u.key ?? 'x'}`).join(' ');

test('in a diff, an added or removed table row stays in its table, marked', () => {
  const groups = diff(' | a | b |', ' |---|---|', ' | 1 | 2 |', '-| 3 | 4 |', '+| 5 | 6 |');
  assert.equal(groups.length, 1);
  assert.equal(kinds(groups[0]), 'same:1 same:3 del:x add:4');
  if (groups[0].type === 'table') assert.equal(renderMarkdown(groups[0].source).match(/<tr>/g)?.length, 4);
});

test('in a diff, a changed header shows both rows in one table', () => {
  const [g, ...rest] = diff('-| a | b |', '+| a | c |', ' |---|---|', ' | 1 | 2 |');
  assert.equal(rest.length, 0);
  assert.equal(kinds(g), 'del:x add:1 same:3');
  if (g.type !== 'table') return assert.fail('expected a table group');
  assert.equal(g.source, '| a | b |\n|---|---|\n| a | c |\n| 1 | 2 |');
});

test('in a diff, a new column hides both delimiters', () => {
  const [g, ...rest] = diff('-| a |', '-|---|', '-| 1 |', '+| a | b |', '+|---|---|', '+| 1 | 2 |');
  assert.equal(rest.length, 0);
  if (g.type !== 'table') return assert.fail('expected a table group');
  assert.deepEqual(
    g.hidden.map((r) => r.t),
    ['|---|', '|---|---|'],
  );
  assert.equal(renderMarkdown(g.source).match(/<tr>/g)?.length, g.units.length);
});

test('in a diff, a list item whose continuation changed is marked changed and shows its new text', () => {
  const [g] = diff(' - one', '-  old detail', '+  new detail', ' - two', '+- three');
  if (g.type !== 'list') return assert.fail('expected a list group');
  assert.equal(kinds(g), 'mod:1 same:3 add:4');
  assert.deepEqual(
    g.hidden.map((r) => r.t),
    ['  old detail'],
  );
  assert.equal(g.source, '- one\n  new detail\n- two\n- three');
});

test('in a diff, a removed fence line is a removed code line', () => {
  const [g] = diff(' ```', ' a', '-b', ' ```');
  assert.equal(kinds(g), 'same:2 del:x');
});

test('inside a list, a fence’s lines and a quote’s text aren’t items, but an item in a quote is', () => {
  // The rendered <li> are a, q, b and c: one target each, in that order.
  const [g] = group('- a\n  > - q\n- b\n  ```\n  - x\n  ```\n- c');
  if (g.type !== 'list') return assert.fail('expected a list group');
  assert.deepEqual(
    g.units.map((u) => u.key),
    [1, 2, 3, 7],
  );
  assert.deepEqual(
    g.units.map((u) => u.lines),
    [[1], [2], [3, 4, 5, 6], [7]],
  );
  assert.equal(renderMarkdown(g.source).match(/<li>/g)?.length, 4);
  const [h] = group('- a\n  ```yaml\n  - x\n  ```\n- b');
  if (h.type === 'list') assert.deepEqual(shape([h]), ['list 1,5']);
});

test('in a diff, a current line that follows a removed item moves to the item above, so it can take a comment', () => {
  const [g] = diff(' - a', '-- b', '+  b');
  if (g.type !== 'list') return assert.fail('expected a list group');
  assert.equal(kinds(g), 'mod:1 del:x');
  assert.deepEqual(
    g.units.map((u) => u.lines),
    [[1, 2], []],
  );
  assert.equal(g.source, '- a\n  b\n- b');
});

test('in a diff, a changed delimiter or fence marker is kept, so the block can show it', () => {
  const [t] = diff(' | a | b |', '-|---|---|', ' | 1 | 2 |');
  if (t.type === 'line') return assert.fail('expected a block');
  assert.deepEqual(
    t.hidden.map((r) => r.kind),
    ['del'],
  );
  const [c] = diff('-```', ' - x', '-```');
  if (c.type !== 'code') return assert.fail('expected a code group');
  assert.deepEqual(
    c.hidden.map((r) => r.kind),
    ['del', 'del'],
  );
});
