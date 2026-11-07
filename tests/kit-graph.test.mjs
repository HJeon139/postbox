// postbox.graph (#888): the kit refuses a graph it can’t draw, naming what’s wrong, and lays out one it can so that no
// node or label overlaps another, each group sits together, and the edges it highlights are the ones asked for. The
// kit’s own scripts run here as a sandbox page runs them, with the bundled d3; only the frame’s drawing is faked.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../app/${path}`, import.meta.url), 'utf8');
const SCRIPTS = ['kit/vendor/d3/d3.min.js', 'kit/kit.js', 'kit/charts.js', 'kit/graph-layout.js', 'kit/graph.js'].map((p) => [p, read(p)]);

/** The kit in a page of its own, with d3 already loaded; mount records what it was given instead of drawing it. */
function kit() {
  const ctx = /** @type {any} */ ({
    document: {
      currentScript: { dataset: { init: JSON.stringify({ appId: 'ap', version: 1 }) } },
      documentElement: { dataset: {} },
      createElement: () => ({}),
      head: { appendChild() {} },
    },
    addEventListener() {},
    parent: { postMessage() {} },
    // d3’s simulation schedules a timer when it’s made; the kit stops it at once and ticks by hand, so none ever runs.
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
  });
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const [path, code] of SCRIPTS) {
    vm.runInContext(code, ctx, { filename: path });
    if (path === 'kit/charts.js') ctx.__pbKit.mount = (el, draw, rows, label) => Object.assign(el, { html: draw(1000), rows, label });
  }
  return ctx.postbox;
}

/** Two packages of modules, each a chain with a few links inside, three links between them and one cycle. */
function twoPackages() {
  const names = ['cart', 'checkout', 'pricing', 'tax', 'discount', 'inventory', 'stock', 'warehouse', 'shipping', 'labels', 'rates', 'returns'];
  const nodes = [
    ...names.map((n, i) => ({ id: `shop/${n}`, label: n, group: 'shop', value: i + 1 })),
    ...['auth', 'session', 'token', 'user', 'profile', 'billing', 'invoice', 'card', 'ledger', 'audit', 'mail', 'events', 'config'].map((n) => ({
      id: `core/${n}`,
      label: n,
      group: 'core',
    })),
  ];
  const chain = (ids) => ids.slice(1).map((id, i) => ({ source: ids[i], target: id }));
  const edges = [
    ...chain(nodes.slice(0, 12).map((n) => n.id)),
    ...chain(nodes.slice(12).map((n) => n.id)),
    { source: 'shop/tax', target: 'shop/cart' },
    { source: 'shop/cart', target: 'core/session' },
    { source: 'shop/checkout', target: 'core/billing' },
    { source: 'shop/returns', target: 'core/ledger' },
  ];
  return {
    nodes,
    edges,
    groups: [
      { id: 'shop', label: 'Shop' },
      { id: 'core', label: 'Core' },
    ],
  };
}

const tooBig = Array.from({ length: 301 }, (_, i) => ({ id: i }));
for (const [what, spec, message] of [
  ['no nodes', { nodes: [] }, /nodes must be a non-empty array/],
  ['more nodes than a network shows', { nodes: tooBig }, /301 nodes is more than the 300 .* adjacency matrix with postbox\.charts\.heatmap/],
  ['a node with no id', { nodes: [{ label: 'x' }] }, /node 1 needs an id/],
  ['two nodes with one id', { nodes: ['a', 'b', 'a'] }, /two nodes have the id “a”/],
  [
    'an edge to a node that isn’t there',
    {
      nodes: ['a', 'b'],
      edges: [
        ['a', 'b'],
        ['b', 'c'],
      ],
    },
    /edge 2 has target “c”, which isn’t a node’s id/,
  ],
  ['a node in a group that isn’t listed', { nodes: [{ id: 'a', group: 'x' }], groups: ['y'] }, /node “a” is in the group “x”, which isn’t in groups/],
  ['a negative value', { nodes: [{ id: 'a', value: -2 }] }, /node “a” has value -2; a value is a number 0 or more/],
  ['more groups than colors', { nodes: Array.from({ length: 9 }, (_, i) => ({ id: i, group: `g${i}` })) }, /9 groups is more than the 8 colors/],
  ['a highlight it doesn’t know', { nodes: ['a'], highlight: 'hubs' }, /highlight must be “between-groups”, “cycles” or a function of the edge, not hubs/],
])
  test(`postbox.graph refuses ${what}, says why, and draws nothing`, async () => {
    const el = {};
    await assert.rejects(kit().graph(el, spec), (e) => {
      assert.match(e.message, /^postbox\.graph: /);
      assert.match(e.message, message);
      return true;
    });
    assert.equal(el.html, undefined);
  });

test('25 nodes in two groups lay out with no node or label over another', async () => {
  const laid = await kit().graph({}, twoPackages());
  const boxes = laid.nodes.flatMap((n) => [
    { id: n.id, x0: n.x - n.r, x1: n.x + n.r, y0: n.y - n.r, y1: n.y + n.r },
    { id: n.id, x0: n.label.x, x1: n.label.x + n.label.width, y0: n.label.y, y1: n.label.y + n.label.height },
  ]);
  const over = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i], boxes[j]];
      if (a.id !== b.id && a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) over.push(`${a.id} and ${b.id}`);
    }
  assert.deepEqual(over, []);
  assert.equal(laid.nodes.length, 25);
  assert.ok(laid.width >= 1000 && laid.height >= 680, `${laid.width} × ${laid.height}`);
  for (const n of laid.nodes) assert.ok(n.x > 0 && n.x < laid.width && n.y > 0 && n.y < laid.height, `${n.id} at ${n.x}, ${n.y} is inside the frame`);
});

test('each group’s nodes sit nearer their own group’s middle than the other’s, and the layout is the same every time', async () => {
  const laid = await kit().graph({}, twoPackages());
  const middle = (prefix) => {
    const ns = laid.nodes.filter((n) => n.id.startsWith(prefix));
    return [ns.reduce((s, n) => s + n.x, 0) / ns.length, ns.reduce((s, n) => s + n.y, 0) / ns.length];
  };
  const mid = { shop: middle('shop/'), core: middle('core/') };
  const away = laid.nodes.filter((n) => {
    const [own, other] = n.id.startsWith('shop/') ? [mid.shop, mid.core] : [mid.core, mid.shop];
    return Math.hypot(n.x - own[0], n.y - own[1]) >= Math.hypot(n.x - other[0], n.y - other[1]);
  });
  assert.deepEqual(
    away.map((n) => n.id),
    [],
  );
  assert.equal(JSON.stringify(await kit().graph({}, twoPackages())), JSON.stringify(laid));
});

test('highlight "cycles" marks the edges on a cycle and no others, and "between-groups" the ones that cross', async () => {
  // Rows come from the kit’s own realm: compare them as plain values.
  const marked = (el) => [...el.rows].slice(1).flatMap((r) => (r.at(-1) === 'Yes' ? [`${r[0]}→${r[1]}`] : []));
  const cycles = {};
  await kit().graph(cycles, { ...twoPackages(), highlight: 'cycles' });
  assert.deepEqual(marked(cycles).sort(), ['cart→checkout', 'checkout→pricing', 'pricing→tax', 'tax→cart']);
  assert.equal(cycles.rows[0].at(-1), 'In a cycle');
  assert.match(cycles.html, /In a cycle/);
  const between = {};
  await kit().graph(between, { ...twoPackages(), highlight: 'between-groups' });
  assert.deepEqual(marked(between).sort(), ['cart→session', 'checkout→billing', 'returns→ledger']);
});

test('nodes as plain ids and edges as pairs draw, with a Table view of the edges and nothing highlighted', async () => {
  const el = {};
  await kit().graph(el, {
    nodes: ['parser', 'lexer', 'ast'],
    edges: [
      ['parser', 'lexer'],
      ['parser', 'ast'],
    ],
    label: 'Parser imports',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(el.rows)), [
    ['From', 'To'],
    ['parser', 'lexer'],
    ['parser', 'ast'],
  ]);
  assert.equal(el.label, 'Parser imports');
  assert.match(el.html, /<svg class="pb-graph" [^>]*role="img" aria-label="Parser imports"/);
  assert.doesNotMatch(el.html, /pb-legend/);
});

test('labels are escaped, never markup', async () => {
  const el = {};
  await kit().graph(el, { nodes: [{ id: 'x', label: '<img src=x onerror=alert(1)>' }] });
  assert.doesNotMatch(el.html, /<img/);
  assert.match(el.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
