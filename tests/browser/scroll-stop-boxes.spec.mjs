// The other scroll boxes take a tab stop only while they scroll (#1968), as a step’s and a command’s output do (#1964,
// app/js/scroll-stop.mjs): a code block, a table block, the Work view’s effort table, a file’s diff and a permission
// card’s draft. A table block says it scrolls only while it does. Each box is drawn by its own module’s exported
// function, in the page, except the table block, which an agent shows.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { scriptedRoom } from './live-scripts.mjs';
import { synced } from './postbox.mjs';

const scripted = scriptedRoom(test, 'scroll-stop-boxes');

for (const width of [375, 1280]) {
  test(`#1968 at ${width} px a code block, a diff and a permission draft take a tab stop only when they scroll`, async ({ page }) => {
    const t = scripted.room(`Boxes at ${width}`, []);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
    await synced(page, scripted.app);
    const stops = await page.evaluate(async () => {
      const { codeBox } = await import('/app/js/code-block.mjs');
      const { diffView } = await import('/app/js/work-diff.mjs');
      const { permissionBlock } = await import('/app/js/permission-cards.mjs');
      const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
      const rows = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'add', n: i + 1, t: `line ${i + 1}` }));
      const draft = (text) =>
        permissionBlock(
          { id: `pm${text.length}`, status: 'open', handle: 'writer', tool: 'mcp__docs__create', outside: true, draft: { field: 'body', text } },
          { threadId: 'th_x' },
        ).querySelector('.perm-draft');
      const boxes = {
        'short code': codeBox({ id: 'c1', type: 'code', code: 'ok' }).querySelector('pre'),
        // A code block has no height limit: a long line is what makes it scroll, sideways.
        'long code': codeBox({ id: 'c2', type: 'code', code: `const wide = '${'x'.repeat(400)}';` }).querySelector('pre'),
        'short diff': diffView({ rows: rows(2) }, { rel: 'a.txt' }),
        'long diff': diffView({ rows: rows(80) }, { rel: 'b.txt' }),
        'short draft': draft('One line.'),
        'long draft': draft(lines(80).replace(/\n/g, '\n\n')),
      };
      const root = document.createElement('div');
      root.style.cssText = 'position: fixed; inset: 0; overflow: auto; background: var(--bg); z-index: 1000';
      document.body.append(root);
      for (const [name, el] of Object.entries(boxes))
        root.append(Object.assign(document.createElement('div'), { title: name }), el.closest('.code, .work-diff-wrap, .block') ?? el);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return Object.fromEntries(
        Object.entries(boxes).map(([name, el]) => [
          name,
          { stop: el.getAttribute('tabindex'), scrolls: el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth },
        ]),
      );
    });
    for (const [name, { stop, scrolls }] of Object.entries(stops)) {
      expect(scrolls, `${name} ${name.startsWith('long') ? 'scrolls' : 'fits'}`).toBe(name.startsWith('long'));
      expect(stop, `${name}: a tab stop only while it scrolls`).toBe(scrolls ? '0' : null);
    }
  });
}

test('#1968 a table block takes a tab stop and says it scrolls only while it does', async ({ page }) => {
  const { rt } = scripted.app;
  const t = scripted.room('Tables', ['tabler']);
  const se = arrange.agentIn(rt, t.id);
  const narrow = [{ id: 'a', label: 'A' }];
  const wide = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, label: `Column ${i}` }));
  const table = (id, columns) =>
    rt.toolsFor(se.id).show_block({
      block: {
        id,
        type: 'table',
        version: 1,
        title: id,
        fallback: id,
        columns,
        rows: [{ id: 'r0', cells: Object.fromEntries(columns.map((c) => [c.id, `${c.label} value, long enough`])) }],
      },
    });
  table('Narrow', narrow);
  table('Wide', wide);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  const fits = page.locator('.tbl-wrap').filter({ hasText: 'A value' });
  const scrolls = page.getByRole('region', { name: 'Wide, scrolls' });
  // It really scrolls, so its stop isn’t only the one a box starts with before it’s measured.
  await expect.poll(() => scrolls.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(scrolls).toHaveAttribute('tabindex', '0');
  await expect(fits).not.toHaveAttribute('tabindex');
  await expect(fits, 'a table that fits isn’t said to scroll').toHaveAttribute('aria-label', 'Narrow');
});

for (const [width, scrolls] of /** @type {const} */ ([
  [375, true],
  [1280, false],
])) {
  test(`#1968 at ${width} px the Work view’s effort table ${scrolls ? 'scrolls and takes' : 'fits and takes no'} tab stop`, async ({ page }) => {
    const t = scripted.room(`Effort at ${width}`, []);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
    await synced(page, scripted.app);
    const got = await page.evaluate(async () => {
      const { effortSection } = await import('/app/js/work-sections.mjs');
      const agent = { handle: 'builder', turns: 3, ms: 61000, toolCalls: 12, tokens: 48000, costUsd: 0.4, priced: true, written: 1200, added: 40, deleted: 3 };
      const s = { turns: [{ id: 't1' }], byAgent: [agent], effort: { ...agent, priced: true }, total: { added: 40, deleted: 3 }, idle: { list: [] } };
      const section = effortSection(s, [], 'th_x', () => ({ items: [], above: null, below: null }));
      const root = document.createElement('div');
      root.style.cssText = 'position: fixed; inset: 0; overflow: auto; background: var(--bg); z-index: 1000; padding: 16px';
      root.append(section);
      document.body.append(root);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const box = /** @type {HTMLElement} */ (root.querySelector('.work-tbl'));
      return { stop: box.getAttribute('tabindex'), scrolls: box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight };
    });
    expect(got.scrolls, `it ${scrolls ? 'scrolls' : 'fits'} at ${width} px`).toBe(scrolls);
    expect(got.stop, 'a tab stop only while it scrolls').toBe(scrolls ? '0' : null);
  });
}

// keepFocus finds a control again by its place among the focusable elements when it has no id. A box that fits has no
// stop before a repaint, and every new box starts with one, so counting stops alone would move focus back one place
// for each fitting box ahead of it (the pre-review of #1968; the Work view repaints this way on every change).
test('#1968 a repaint that keeps focus leaves it on the control after a box that fits', async ({ page }) => {
  const t = scripted.room('Focus after a box', []);
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  const after = await page.evaluate(async () => {
    const { keepFocus } = await import('/app/js/ui.mjs');
    const { diffView } = await import('/app/js/work-diff.mjs');
    const { h } = await import('/app/js/dom.mjs');
    const root = document.createElement('div');
    document.body.append(root);
    const paint = () =>
      root.replaceChildren(
        h('button', { type: 'button' }, 'A'),
        diffView({ rows: [{ kind: 'add', n: 1, t: 'one line' }] }, { rel: 'a.txt' }),
        h('button', { type: 'button' }, 'B'),
        h('button', { type: 'button' }, 'C'),
      );
    paint();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = /** @type {HTMLElement} */ ([...root.querySelectorAll('button')].find((b) => b.textContent === 'C'));
    c.focus();
    keepFocus(root, paint);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return document.activeElement?.textContent;
  });
  expect(after, 'focus came back to C, not the control before it').toBe('C');
});
