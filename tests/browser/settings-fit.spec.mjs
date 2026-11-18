// Settings fits the window with long host names (#1497, from the owner’s UAT of Settings with remote hosts): from 320
// to 1920 px the dialog stays inside the window, each persona row keeps its host and its description readable, with
// nothing drawn over anything else, and Projects isn’t cut off on a phone.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const HOSTS = [
  ['cloud-builder', 'ip-10-123-45-67.us-west-2.compute.internal', 'Builds and tests the service on the cloud instance.'],
  ['trainer', 'gpu-build-a100-03.lab.example.net', 'Runs training jobs and evaluations on the GPU box.'],
];
test.beforeAll(async () => {
  app = await startPostbox('settings-fit');
  // A Claude Code to run on the hosts, so the persona editor can ask for its models.
  arrange.withAdapter(app.rt, { name: 'claude-code', folderFor: async () => app.root, async deliver() {} });
  for (const [handle, name, description] of HOSTS) {
    const persona = app.rt.createPersona({ handle, backend: 'mock', description });
    // Claude Code on a host, set through the store: the hosts here are records, with nothing running on them.
    const remote = { hostId: app.rt.addHost({ name }).id };
    app.store.emit('persona', { ...app.store.state.personas[persona.id], backend: 'claude-code', remote });
  }
  arrange.persona(app.rt, 'librarian');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** Opens Settings on a tab at the given width. */
async function settings(page, width, tab) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: tab }).click();
  await settled(page);
  return dialog;
}

/** Where the dialog is, and whether the page scrolls sideways. */
const placed = (page) =>
  page.evaluate(() => {
    const d = /** @type {Element} */ (document.querySelector('.dialog')).getBoundingClientRect();
    return { left: d.left, right: d.right, width: innerWidth, sideways: document.documentElement.scrollWidth > innerWidth };
  });

for (const width of [320, 375, 768, 1024, 1280, 1920])
  test(`#1497 at ${width} px Settings is inside the window, and each persona row keeps its host and description readable`, async ({ page }) => {
    const dialog = await settings(page, width, 'Personas');
    const at = await placed(page);
    expect.soft(at.left, 'its left edge in the window').toBeGreaterThanOrEqual(0);
    expect.soft(at.right, 'its right edge in the window').toBeLessThanOrEqual(at.width + 0.5);
    expect.soft(at.sideways, 'the page doesn’t scroll sideways').toBe(false);
    for (const [handle, host, description] of HOSTS) {
      const row = dialog.locator('li', { has: page.getByText(handle, { exact: true }) });
      const look = await row.evaluate((li, host) => {
        const kids = [...li.children].map((el) => ({ el, r: el.getBoundingClientRect() }));
        const overlaps = [];
        for (const [i, a] of kids.entries())
          for (const b of kids.slice(i + 1)) {
            const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
            const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
            if (x > 1 && y > 1) overlaps.push(`${a.el.textContent} / ${b.el.textContent}`);
          }
        const where = kids.find((k) => k.el.textContent?.includes('On '))?.el;
        const said = kids.find((k) => k.el.matches('.grow'))?.el;
        const lineOf = (/** @type {Element} */ el) => Number.parseFloat(getComputedStyle(el).lineHeight) || 17;
        return {
          overlaps,
          hostTitle: where?.getAttribute('title') ?? where?.textContent ?? '',
          hostLines: where ? Math.round(where.getBoundingClientRect().height / lineOf(where)) : 0,
          hostShows: where ? where.getBoundingClientRect().width : 0,
          lines: said ? Math.round(said.getBoundingClientRect().height / lineOf(said)) : 0,
          text: said?.textContent ?? '',
          fullName: host,
        };
      }, host);
      expect.soft(look.overlaps, `${handle}: nothing drawn over anything else`).toEqual([]);
      expect.soft(look.hostTitle, `${handle}: its whole host name is there to read`).toBe(`On ${host}`);
      expect.soft(look.hostLines, `${handle}: its host on one line`).toBe(1);
      expect.soft(look.hostShows, `${handle}: enough of its host shows to tell it apart`).toBeGreaterThanOrEqual(80);
      expect.soft(look.text, `${handle}: its description`).toBe(description);
      expect.soft(look.lines, `${handle}: its description reads in lines, not a word to a line`).toBeLessThanOrEqual(3);
    }
  });

for (const width of [320, 375])
  test(`#1497 at ${width} px Settings › Projects isn’t cut off`, async ({ page }) => {
    const dialog = await settings(page, width, 'Projects');
    const at = await placed(page);
    expect.soft(at.right, 'its right edge in the window').toBeLessThanOrEqual(at.width + 0.5);
    expect.soft(at.sideways, 'the page doesn’t scroll sideways').toBe(false);
    const cut = await dialog.locator('[role="tabpanel"]').evaluate((panel) => {
      const box = panel.getBoundingClientRect();
      return [...panel.querySelectorAll('*')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width && r.right > box.right + 1;
        })
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`)
        .slice(0, 5);
    });
    expect.soft(cut, 'nothing past the panel’s right edge').toEqual([]);
  });

for (const width of [320, 375])
  test(`#1497 at ${width} px a persona’s model hint keeps its host’s name whole`, async ({ page }) => {
    const dialog = await settings(page, width, 'Personas');
    await dialog.getByRole('button', { name: 'Edit trainer' }).click();
    const name = dialog.locator('[data-model-help] .host-name');
    await expect(name).toHaveText('gpu-build-a100-03.lab.example.net');
    // One box: the name moved to its own line whole, rather than breaking at a hyphen.
    await expect.poll(() => name.evaluate((el) => el.getClientRects().length), { message: 'the host’s name in one box' }).toBe(1);
  });
