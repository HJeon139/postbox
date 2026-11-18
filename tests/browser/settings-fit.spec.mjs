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
// One segment with no hyphen or space to break at, as a generated folder name can be.
const FOLDER = '/Users/someone/Documents/research/FieldNotesArchive2026InterviewsWithTheLibrariansOfTheNorthWing/transcripts';
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
  // A project whose folder is long, shown only: nothing runs in it.
  app.store.emit('project', { id: 'pr_fit', name: 'Field notes', folder: FOLDER });
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
      const look = await row.evaluate((li) => {
        const kids = [...li.children].map((el) => ({ el, r: el.getBoundingClientRect() }));
        const overlaps = [];
        for (const [i, a] of kids.entries())
          for (const b of kids.slice(i + 1)) {
            const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
            const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
            if (x > 1 && y > 1) overlaps.push(`${a.el.textContent} / ${b.el.textContent}`);
          }
        const where = /** @type {HTMLElement} */ (kids.find((k) => k.el.textContent?.includes('On '))?.el);
        const said = /** @type {Element} */ (kids.find((k) => k.el.matches('.grow'))?.el);
        const top = (/** @type {string} */ sel) => li.querySelector(sel)?.getBoundingClientRect().top ?? Number.NaN;
        const lineOf = (/** @type {Element} */ el) => Number.parseFloat(getComputedStyle(el).lineHeight) || 17;
        const hr = where.getBoundingClientRect();
        const sr = said.getBoundingClientRect();
        return {
          overlaps,
          hostTitle: where.getAttribute('title') ?? '',
          hostText: where.textContent,
          hostCut: where.scrollWidth > where.clientWidth + 1,
          hostLines: Math.round(hr.height / lineOf(where)),
          hostShows: hr.width,
          // On a phone: the name, its version and Edit on one line, the host under them, the description under that.
          nameLine: Math.max(Math.abs(top('b') - top('button')), Math.abs(top('b') - top('.on-host ~ span'))) < lineOf(where),
          hostBelowName: hr.top >= (li.querySelector('b')?.getBoundingClientRect().bottom ?? 0) - 1,
          saidBelowHost: sr.top >= hr.bottom - 1,
          lines: Math.round(sr.height / lineOf(said)),
          text: said.textContent ?? '',
        };
      });
      expect.soft(look.overlaps, `${handle}: nothing drawn over anything else`).toEqual([]);
      expect.soft(look.hostTitle, `${handle}: its whole host name is in its title`).toBe(`On ${host}`);
      if (width <= 600) {
        // A phone has no hover: the whole name shows, wrapped, on a line of its own, and the description under it.
        expect.soft([look.hostText, look.hostCut], `${handle}: its whole host name shows`).toEqual([`On ${host}`, false]);
        expect.soft(look.nameLine, `${handle}: its name, version and Edit on one line`).toBe(true);
        expect.soft(look.hostBelowName, `${handle}: its host under its name`).toBe(true);
        expect.soft(look.saidBelowHost, `${handle}: its description under its host`).toBe(true);
      } else {
        expect.soft(look.hostLines, `${handle}: its host on one line`).toBe(1);
        expect.soft(look.hostShows, `${handle}: enough of its host shows to tell it apart`).toBeGreaterThanOrEqual(80);
      }
      expect.soft(look.text, `${handle}: its description`).toBe(description);
      expect.soft(look.lines, `${handle}: its description reads in lines, not a word to a line`).toBeLessThanOrEqual(3);
    }
  });

for (const width of [320, 375, 599, 1280])
  test(`#1497 at ${width} px Settings › Projects isn’t cut off, and its folder and repository field are usable`, async ({ page }) => {
    const dialog = await settings(page, width, 'Projects');
    const at = await placed(page);
    expect.soft(at.right, 'its right edge in the window').toBeLessThanOrEqual(at.width + 0.5);
    expect.soft(at.sideways, 'the page doesn’t scroll sideways').toBe(false);
    const row = dialog.locator('li', { has: page.getByText('Field notes', { exact: true }) });
    const look = await row.evaluate((li) => {
      const r = (/** @type {string} */ sel) => /** @type {Element} */ (li.querySelector(sel)).getBoundingClientRect();
      const tab = /** @type {Element} */ (li.closest('[role="tabpanel"]'));
      const form = /** @type {Element} */ (tab.querySelector('.form-grid')).getBoundingClientRect();
      return {
        li: li.getBoundingClientRect(),
        name: r('.row-flex'),
        folder: r('.mono.grow'),
        // Its text, not its box: a word that can’t break runs past a box that stays the row’s width.
        folderSpills: (() => {
          const el = /** @type {Element} */ (li.querySelector('.mono.grow'));
          return el.scrollWidth > el.clientWidth + 1;
        })(),
        field: r('.field'),
        input: r('input'),
        save: r('button'),
        panel: tab.getBoundingClientRect(),
        form,
      };
    });
    expect.soft(look.save.right, '“Save repository” inside the panel').toBeLessThanOrEqual(look.panel.right + 0.5);
    expect.soft(look.folderSpills, 'the folder wraps inside its line, even a part with nothing to break at').toBe(false);
    if (width < 600) expect.soft(look.field.top, 'on a phone, where it pushes is under its folder').toBeGreaterThanOrEqual(look.name.bottom - 1);
    expect.soft(look.input.width, 'a repository field you can type in').toBeGreaterThanOrEqual(120);
    expect.soft(look.folder.width, 'a folder that reads in lines, not a character to a line').toBeGreaterThanOrEqual(150);
    // As wide as the form under it: the column’s 760 px cap is the conversation’s, not a dialog’s rows’.
    expect.soft(Math.abs(look.li.width - look.form.width), 'the row spans the panel, as the form does').toBeLessThanOrEqual(10);
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
