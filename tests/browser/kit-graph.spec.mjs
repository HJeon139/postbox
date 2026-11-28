// #888: postbox.graph(el, { nodes, edges, groups, highlight }) lays out a directed network with d3-force, groups nodes
// into soft cluster regions, keeps 12 px non-overlapping labels, highlights cross-group/cycle edges, scrolls sideways
// in a narrow window without shrinking text, and provides a Table view.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const GRAPH_APP = `<main style="padding:12px">
  <h2 style="margin:0 0 8px">Module dependencies</h2>
  <div id="g"></div>
</main>
<script>
postbox.ready.then(async () => {
  const nodes = [];
  for (let i = 1; i <= 13; i++) nodes.push({ id: 'core-' + i, label: 'core-' + i, group: 'core', value: i === 1 ? 40 : 10 });
  for (let i = 1; i <= 12; i++) nodes.push({ id: 'ui-' + i, label: 'ui-' + i, group: 'ui', value: i === 1 ? 30 : 8 });
  const edges = [];
  for (let i = 1; i < 13; i++) edges.push({ from: 'core-' + i, to: 'core-' + (i + 1) });
  for (let i = 1; i < 12; i++) edges.push({ from: 'ui-' + i, to: 'ui-' + (i + 1) });
  // Cross-group edges + a cycle + a self-loop.
  edges.push({ from: 'ui-1', to: 'core-1', label: 'imports' });
  edges.push({ from: 'ui-5', to: 'core-3', label: 'queries' });
  edges.push({ from: 'core-2', to: 'core-1' });
  edges.push({ from: 'core-4', to: 'core-4' });
  await postbox.graph(document.getElementById('g'), {
    label: 'Module dependencies',
    groups: [{ id: 'core', label: 'Core engine' }, { id: 'ui', label: 'Client UI' }],
    nodes,
    edges,
    highlight: 'cross-group',
  });
});
</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('kit-graph');
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** Measures computed font sizes and pairwise overlaps of every rendered node label. */
const labelMetrics = (frame) =>
  frame.locator('[data-node-label]').evaluateAll((els) => {
    const boxes = els.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute('data-node-label'), x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, fs: Number.parseFloat(getComputedStyle(el).fontSize) };
    });
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) overlaps.push([a.id, b.id]);
      }
    }
    return { minFont: Math.min(...boxes.map((b) => b.fs)), overlaps };
  });

/** Creates a thread, shows a graph app in it, opens the page, and returns the app iframe locator. */
const openGraphApp = async (page, title, id, code) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { rt, store } = app;
  const thread = rt.createThread({
    projectId: Object.values(store.state.projects)[0].id,
    title,
    personaIds: [arrange.persona(rt, 'researcher').id],
  });
  const shown = rt.toolsFor(arrange.agentIn(rt, thread.id).id).show_app({ id, title, code });
  expect(shown.ok, shown.message).toBe(true);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  return { rt, frame: page.frameLocator('iframe.app-iframe').first() };
};

test('#888 postbox.graph renders 25 nodes in two groups with ≥12 px non-overlapping labels, highlights, horizontal scroll, and Table view', async ({
  page,
}) => {
  const { rt, frame } = await openGraphApp(page, 'Graph test', 'dep-graph', GRAPH_APP);
  await expect.poll(() => rt.store.state.apps['dep-graph'].check.status, { timeout: 15_000 }).toBe('passed');
  await synced(page, app);
  await expect(frame.locator('[data-node]'), 'all 25 nodes drawn').toHaveCount(25, { timeout: 15_000 });
  await expect(frame.locator('.pb-graph-groups path'), 'two soft group cluster regions').toHaveCount(2);
  await expect(frame.locator('[data-highlight="1"]'), 'both cross-group edges highlighted').toHaveCount(2);

  // Node value sizing: core-1 (value 40) is larger than core-2 (value 10).
  const rBig = Number(await frame.locator('[data-node="core-1"]').getAttribute('r'));
  const rSmall = Number(await frame.locator('[data-node="core-2"]').getAttribute('r'));
  expect(rBig, 'larger value draws larger node').toBeGreaterThan(rSmall);

  // Every label is ≥12 px and no two label boxes overlap.
  const metrics = await labelMetrics(frame);
  expect(metrics.minFont, 'every label is at least 12 px').toBeGreaterThanOrEqual(12);
  expect(metrics.overlaps, 'no two node labels overlap').toEqual([]);

  // Table view lists every node and edge (move pointer over the iframe so it becomes live, as a person does).
  const tableBtn = frame.getByRole('radio', { name: 'Table' });
  const tb = await tableBtn.boundingBox();
  if (!tb) throw new Error('Table button has no box.');
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await expect(page.locator('iframe.app-iframe').first()).toHaveClass(/\blive\b/);
  await tableBtn.click();
  await expect(frame.locator('.pb-graph-tables tbody tr')).toHaveCount(25 + 27);
  await frame.getByRole('radio', { name: 'Graph' }).click();
  await expect(frame.locator('.pb-graph-scroll')).toBeVisible();

  // Narrow window (375 px): scrolls sideways, becomes keyboard-focusable with a label, and keeps labels ≥12 px.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(frame.locator('.pb-graph-scroll')).toHaveAttribute('tabindex', '0');
  await expect(frame.locator('.pb-graph-scroll')).toHaveAttribute('role', 'region');
  await expect(frame.locator('.pb-graph-scroll')).toHaveAttribute('aria-label', /Module dependencies/);
  const narrow = await frame.locator('.pb-graph-scroll').evaluate((el) => ({
    scrollW: el.scrollWidth,
    clientW: el.clientWidth,
    minFont: Math.min(...[...el.querySelectorAll('[data-node-label]')].map((n) => Number.parseFloat(getComputedStyle(n).fontSize))),
  }));
  expect(narrow.scrollW, 'scrolls sideways in a narrow window').toBeGreaterThan(narrow.clientW);
  expect(narrow.minFont, 'labels stay ≥12 px in a narrow window').toBeGreaterThanOrEqual(12);
});

const CJK_AND_DENSE_APP = `<main style="padding:12px">
  <div id="cjk"></div>
  <div id="dense"></div>
</main>
<script>
postbox.ready.then(async () => {
  const cjkNodes = [];
  for (let i = 1; i <= 13; i++) cjkNodes.push({ id: 'c' + i, label: '模块管理器' + i, group: 'core', value: i });
  for (let i = 1; i <= 12; i++) cjkNodes.push({ id: 'u' + i, label: '画面制御' + i, group: 'ui', value: i });
  const cjkEdges = [];
  for (let i = 1; i < 13; i++) cjkEdges.push({ from: 'c' + i, to: 'c' + (i + 1) });
  for (let i = 1; i < 12; i++) cjkEdges.push({ from: 'u' + i, to: 'u' + (i + 1) });
  cjkEdges.push({ from: 'u1', to: 'c1' });
  await postbox.graph(document.getElementById('cjk'), {
    label: 'Non-Latin module graph',
    groups: [{ id: 'core', label: '核心' }, { id: 'ui', label: '界面' }],
    nodes: cjkNodes,
    edges: cjkEdges,
    highlight: 'cross-group',
  });
  const denseNodes = Array.from({ length: 40 }, (_, i) => ({ id: 'd' + i, label: '节点' + i, group: i % 2 ? 'a' : 'b' }));
  const denseEdges = Array.from({ length: 39 }, (_, i) => ({ from: 'd' + i, to: 'd' + (i + 1) }));
  await postbox.graph(document.getElementById('dense'), {
    label: 'Dense small graph',
    width: 360,
    height: 260,
    nodes: denseNodes,
    edges: denseEdges,
  });
});
</script>`;

test('#888 postbox.graph measures non-Latin labels and grows height when dense labels need more room', async ({ page }) => {
  const { frame } = await openGraphApp(page, 'Graph CJK and dense test', 'cjk-graph', CJK_AND_DENSE_APP);
  await expect(frame.locator('#cjk [data-node-label]')).toHaveCount(25, { timeout: 15_000 });
  await expect(frame.locator('#dense [data-node-label]')).toHaveCount(40, { timeout: 15_000 });

  const cjkMetrics = await labelMetrics(frame.locator('#cjk'));
  expect(cjkMetrics.minFont, 'CJK labels stay ≥12 px').toBeGreaterThanOrEqual(12);
  expect(cjkMetrics.overlaps, 'zero overlapping CJK labels').toEqual([]);

  const denseMetrics = await labelMetrics(frame.locator('#dense'));
  expect(denseMetrics.minFont, 'dense labels stay ≥12 px').toBeGreaterThanOrEqual(12);
  expect(denseMetrics.overlaps, 'zero overlapping labels in dense 360×260 graph').toEqual([]);
  const denseH = Number(await frame.locator('#dense svg').getAttribute('height'));
  expect(denseH, 'dense graph grew vertically past 260 px to fit labels').toBeGreaterThan(260);
});
