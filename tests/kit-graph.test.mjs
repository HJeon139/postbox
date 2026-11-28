// #888: unit tests for app/kit/graph-layout.js (normalization, Tarjan cycle detection, cross-group/cycle/explicit
// highlights, value-based node sizing, and label de-overlap).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const fakeWindow = /** @type {any} */ ({});
for (const file of ['graph-layout.js', 'graph-cycles.js', 'graph-labels.js']) {
  new Function('window', readFileSync(join(import.meta.dirname, '..', 'app', 'kit', file), 'utf8'))(fakeWindow);
}
const layout = fakeWindow.__pbGraphLayout;

test('#888 normalizeSpec assigns categorical group tokens, scales radii by value, and drops dangling edges', () => {
  const s = layout.normalizeSpec({
    groups: [
      { id: 'core', label: 'Core' },
      { id: 'ui', label: 'UI' },
    ],
    nodes: [
      { id: 'a', label: 'A', group: 'core', value: 10 },
      { id: 'b', label: 'B', group: 'ui', value: 90 },
      { id: 'c', group: 'ui' },
    ],
    edges: [
      { from: 'a', to: 'b', label: 'calls' },
      { from: 'a', to: 'missing' },
    ],
  });
  assert.equal(s.width, 960);
  assert.equal(s.height, 540);
  assert.deepEqual(
    s.groups.map((g) => [g.id, g.color]),
    [
      ['core', 's1'],
      ['ui', 's2'],
    ],
  );
  assert.equal(s.edges.length, 1, 'dangling edge dropped');
  assert.ok(s.byId.get('b').r > s.byId.get('a').r, 'larger value yields larger node radius');
  assert.equal(s.byId.get('c').label, 'c', 'missing label defaults to id');
});

test('#888 bounds oversized dimensions and falls back from non-finite dimensions', () => {
  const graph = layout.normalizeSpec({ width: 1e20, height: Infinity });
  assert.equal(graph.width, 16_384);
  assert.equal(graph.height, 540);
});

test('#888 markHighlights detects cycles (Tarjan SCC + self-loops), cross-group edges, and explicit pairs', () => {
  const base = () =>
    layout.normalizeSpec({
      nodes: [
        { id: 'a', group: 'g1' },
        { id: 'b', group: 'g1' },
        { id: 'c', group: 'g2' },
        { id: 'd', group: 'g2' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' }, // 2-node cycle
        { from: 'b', to: 'c' }, // cross-group, not in cycle
        { from: 'c', to: 'd' },
        { from: 'd', to: 'd' }, // self-loop
      ],
    });

  const sCyc = base();
  fakeWindow.__pbGraphHighlights(sCyc, 'cycles');
  assert.deepEqual(
    sCyc.edges.filter((e) => e.highlight).map((e) => `${e.from}->${e.to}`),
    ['a->b', 'b->a', 'd->d'],
  );

  const sCross = base();
  fakeWindow.__pbGraphHighlights(sCross, 'cross-group');
  assert.deepEqual(
    sCross.edges.filter((e) => e.highlight).map((e) => `${e.from}->${e.to}`),
    ['b->c'],
  );

  const sExplicit = base();
  fakeWindow.__pbGraphHighlights(sExplicit, [{ from: 'c', to: 'd' }]);
  assert.deepEqual(
    sExplicit.edges.filter((e) => e.highlight).map((e) => `${e.from}->${e.to}`),
    ['c->d'],
  );
});

test('#888 keeps node and group labels apart and omits labels wider than the canvas', () => {
  const node = { x: 180, y: 130, r: 12 };
  const candidates = [
    { ...node, text: 'Group', w: 72, h: 16 },
    { ...node, text: 'Module', w: 72, h: 16 },
    { ...node, text: 'Wide label', w: 400, h: 16 },
  ];
  const labels = fakeWindow.__pbGraphLabels(candidates, [node], 360, 260);
  assert.deepEqual(
    labels.map(({ text }) => text),
    ['Group', 'Module'],
  );
  assert.ok(labels[0].y - labels[1].y > 16);
  assert.ok(labels[0].y - labels[0].h >= node.y + node.r);
  assert.ok(labels[1].y < node.y - node.r);
});

test('#888 marks cycles at the end of a 10,000-node dependency chain', () => {
  const nodes = Array.from({ length: 10_000 }, (_, i) => ({ id: i }));
  const edges = nodes.slice(1).map((node, i) => ({ from: i, to: node.id }));
  edges.push({ from: 9999, to: 9998 });
  const state = layout.normalizeSpec({ nodes, edges });
  fakeWindow.__pbGraphHighlights(state, 'cycles');
  assert.deepEqual(
    state.edges.filter((edge) => edge.inCycle).map(({ from, to }) => [from, to]),
    [
      ['9998', '9999'],
      ['9999', '9998'],
    ],
  );
});
