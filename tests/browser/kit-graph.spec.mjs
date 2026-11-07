// postbox.graph (#888) in a real app frame: a network of 25 modules in two packages draws with every label at 12 px or
// more and no label over another, passes the pre-display check at both widths, and has a Table view of its edges.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

const SHOP = ['cart', 'checkout', 'pricing', 'tax', 'discount', 'inventory', 'stock', 'warehouse', 'shipping', 'labels', 'rates', 'returns'];
const CORE = ['auth', 'session', 'token', 'user', 'profile', 'billing', 'invoice', 'card', 'ledger', 'audit', 'mail', 'events', 'config'];
const chain = (ids) => ids.slice(1).map((id, i) => [ids[i], id]);
const SPEC = {
  label: 'How the shop and core packages import each other',
  groups: [
    { id: 'shop', label: 'Shop' },
    { id: 'core', label: 'Core' },
  ],
  nodes: [
    ...SHOP.map((n, i) => ({ id: `shop/${n}`, label: n, group: 'shop', value: i + 1 })),
    ...CORE.map((n) => ({ id: `core/${n}`, label: n, group: 'core' })),
  ],
  edges: [
    ...chain(SHOP.map((n) => `shop/${n}`)),
    ...chain(CORE.map((n) => `core/${n}`)),
    ['shop/tax', 'shop/cart'],
    ['shop/cart', 'core/session'],
    ['shop/checkout', 'core/billing'],
    ['shop/returns', 'core/ledger'],
  ],
  highlight: 'cycles',
};
const APP = `<main style="padding:12px"><div id="g"></div></main>
<script>postbox.graph(document.getElementById('g'), ${JSON.stringify(SPEC)});</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let thread;
test.beforeAll(async () => {
  app = await startPostbox('kit-graph');
  const { rt } = app;
  rt.adapters.register({ name: 'mock', async deliver() {} });
  thread = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title: 'Graph', personaIds: [rt.createPersona({ handle: 'drawer' }).id] });
  rt.toolsFor(rt.sessionsIn(thread.id)[0].id).show_app({ id: 'deps', title: 'Package imports', code: APP });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });

test('25 modules in two packages draw with labels of 12 px or more, none over another, and pass the check at both widths', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const frame = page.frameLocator('.transcript .appframe iframe');
  await expect(frame.locator('svg.pb-graph circle')).toHaveCount(25);
  await settled(page);
  const labels = await frame.locator('svg.pb-graph text').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent, size: parseFloat(getComputedStyle(el).fontSize), x0: r.left, x1: r.right, y0: r.top, y1: r.bottom };
    }),
  );
  expect.soft(labels.length, 'a label for each node and each group').toBe(27);
  expect.soft(labels.filter((l) => l.size < 12).map((l) => `${l.text}: ${l.size} px`)).toEqual([]);
  const over = [];
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      const [a, b] = [labels[i], labels[j]];
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) over.push(`${a.text} over ${b.text}`);
    }
  expect.soft(over, 'labels drawn over each other').toEqual([]);
  await expect.poll(() => app.rt.s.apps.deps.check.status, { message: 'the pre-display check finished', timeout: 60_000 }).not.toBe('pending');
  expect.soft(app.rt.s.apps.deps.check.problems ?? [], 'what the check found').toEqual([]);
  expect.soft(app.rt.s.apps.deps.check.status).toBe('passed');
});

test('the Table view lists every edge, with the ones on a cycle marked', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const frame = page.frameLocator('.transcript .appframe iframe');
  await expect(frame.getByRole('radio', { name: 'Table' })).toBeVisible();
  await expect(frame.locator('.pb-legend')).toContainText('In a cycle');
  // A frame takes no pointer events until the page sees the pointer over it (#38).
  await page.locator('.app-body[data-app-id="deps"]').hover();
  await frame.getByRole('radio', { name: 'Table' }).click();
  await expect(frame.locator('.pb-table tbody tr')).toHaveCount(SPEC.edges.length);
  await expect(frame.locator('.pb-table tbody tr', { hasText: 'Yes' })).toHaveCount(4);
  await expect(frame.locator('svg.pb-graph')).toBeHidden();
});
