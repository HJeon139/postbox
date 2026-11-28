// #888: unit tests for app/kit/graph-layout.js (normalization, Tarjan cycle detection, cross-group/cycle/explicit
// highlights, value-based node sizing, and label de-overlap).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const src = readFileSync(join(import.meta.dirname, '..', 'app', 'kit', 'graph-layout.js'), 'utf8');
const fakeWindow = /** @type {any} */ ({});
new Function('window', src)(fakeWindow);
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
  layout.markHighlights(sCyc, 'cycles');
  assert.deepEqual(
    sCyc.edges.filter((e) => e.highlight).map((e) => `${e.from}->${e.to}`),
    ['a->b', 'b->a', 'd->d'],
  );

  const sCross = base();
  layout.markHighlights(sCross, 'cross-group');
  assert.deepEqual(
    sCross.edges.filter((e) => e.highlight).map((e) => `${e.from}->${e.to}`),
    ['b->c'],
  );

  const sExplicit = base();
  layout.markHighlights(sExplicit, [{ from: 'c', to: 'd' }]);
  assert.deepEqual(
    sExplicit.edges.filter((e) => e.highlight).map((e) => `${e.from}->${e.to}`),
    ['c->d'],
  );
});

test('#888 placeLabels separates stacked node labels so zero label boxes overlap', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({
    id: `n${i}`,
    label: `module-${i}`,
    x: 400 + (i % 3) * 4,
    y: 250 + Math.floor(i / 3) * 4,
    r: 9,
    labelW: 72,
  }));
  const labels = layout.placeLabels(nodes, 960, 540);
  const overlaps = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i];
      const b = labels[j];
      if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < a.h) overlaps.push([a.node.id, b.node.id]);
    }
  }
  assert.deepEqual(overlaps, [], 'all overlapping labels were separated');
});

test('#888 placeLabels grows drawing height when dense labels cannot fit in a small canvas', () => {
  const nodes = Array.from({ length: 40 }, (_, i) => ({
    id: `n${i}`,
    label: `node-${i}`,
    x: 40 + (i % 8) * 38,
    y: 40 + Math.floor(i / 8) * 40,
    r: 9,
    labelW: 110,
  }));
  const labels = layout.placeLabels(nodes, 360, 260);
  const overlaps = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i];
      const b = labels[j];
      if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2) overlaps.push([a.node.id, b.node.id]);
    }
  }
  assert.deepEqual(overlaps, [], 'dense 40-node labels have zero overlaps');
  assert.ok(labels.height > 260, `height grew beyond 260 (got ${labels.height})`);
});
