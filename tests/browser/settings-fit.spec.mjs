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
/** A project name of 70 characters: the app allows 80. */
const LONG_PROJECT = 'Interviews with the librarians of the north wing, transcribed in 2026';
/** 70 characters with no dot, hyphen or space to break at. */
const UNBROKEN = 'labworkstation' + 'x'.repeat(42) + 'gpuclusternode';
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
  app.store.emit('project', { id: 'pr_fit_long', name: LONG_PROJECT, folder: FOLDER });
  app.store.emit('project', { id: 'pr_fit_unbroken', name: UNBROKEN, folder: FOLDER });
  // A host whose name has nothing to break at: no dot, hyphen or space.
  app.rt.addHost({ name: UNBROKEN });
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

for (const width of [320, 375, 599, 1024, 1280])
  test(`#1497 at ${width} px Settings › Projects isn’t cut off, and each project’s name, folder and repository field are usable`, async ({ page }) => {
    const dialog = await settings(page, width, 'Projects');
    const at = await placed(page);
    expect.soft(at.right, 'its right edge in the window').toBeLessThanOrEqual(at.width + 0.5);
    expect.soft(at.sideways, 'the page doesn’t scroll sideways').toBe(false);
    for (const project of ['Field notes', LONG_PROJECT, UNBROKEN]) await projectRow(dialog, page, width, project);
  });

/** One project’s row: its name and folder read in lines, its folder under its name, and its repository field usable. */
async function projectRow(dialog, page, width, project) {
  const row = dialog.locator('li', { has: page.getByText(project, { exact: true }) });
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
      title: r('b'),
      titleSpills: (() => {
        const el = /** @type {Element} */ (li.querySelector('b'));
        return el.scrollWidth > el.clientWidth + 1;
      })(),
      field: r('.field'),
      input: r('input'),
      save: r('button'),
      panel: tab.getBoundingClientRect(),
      form,
    };
  });
  const of = (/** @type {string} */ what) => `${project.slice(0, 12)}…: ${what}`;
  expect.soft(look.save.right, of('“Save repository” inside the panel')).toBeLessThanOrEqual(look.panel.right + 0.5);
  expect.soft([look.titleSpills, look.folderSpills], of('its name and folder wrap inside their lines')).toEqual([false, false]);
  expect.soft(look.title.right, of('its name inside the panel, even one with nothing to break at')).toBeLessThanOrEqual(look.panel.right + 0.5);
  expect.soft(look.folder.top, of('its folder under its name, at every width')).toBeGreaterThanOrEqual(look.title.bottom - 1);
  if (width < 600) expect.soft(look.field.top, of('on a phone, where it pushes is under its folder')).toBeGreaterThanOrEqual(look.name.bottom - 1);
  // With room for both, where it pushes is beside its folder, not under it (16em and 22em).
  else if (width > 1000) expect.soft(look.field.top, of('with room, where it pushes is beside its folder')).toBeLessThan(look.name.bottom - 1);
  expect.soft(look.input.width, of('a repository field you can type in')).toBeGreaterThanOrEqual(120);
  expect.soft(look.folder.width, of('a folder that reads in lines, not a character to a line')).toBeGreaterThanOrEqual(150);
  // As wide as the form under it: the column’s 760 px cap is the conversation’s, not a dialog’s rows’.
  expect.soft(Math.abs(look.li.width - look.form.width), of('the row spans the panel, as the form does')).toBeLessThanOrEqual(10);
}

for (const width of [320, 375])
  test(`#1497 at ${width} px a persona’s model hint keeps its host’s name whole`, async ({ page }) => {
    const dialog = await settings(page, width, 'Personas');
    await dialog.getByRole('button', { name: 'Edit trainer' }).click();
    const name = dialog.locator('[data-model-help] .host-name');
    await expect(name).toHaveText('gpu-build-a100-03.lab.example.net');
    // One box: the name moved to its own line whole, rather than breaking at a hyphen.
    await expect.poll(() => name.evaluate((el) => el.getClientRects().length), { message: 'the host’s name in one box' }).toBe(1);
  });

for (const width of [320, 375, 540])
  test(`#1497 at ${width} px Settings › Hosts cuts off no host’s name, even one with nothing to break at`, async ({ page }) => {
    const dialog = await settings(page, width, 'Hosts');
    await expect(dialog.getByText(UNBROKEN).first()).toBeVisible();
    const at = await placed(page);
    expect.soft(at.right, 'its right edge in the window').toBeLessThanOrEqual(at.width + 0.5);
    expect.soft(at.sideways, 'the page doesn’t scroll sideways').toBe(false);
    // Every element whose own text runs past its box, or past the panel.
    const cut = await dialog.locator('[role="tabpanel"]').evaluate((panel) => {
      const edge = panel.getBoundingClientRect().right;
      return [...panel.querySelectorAll('*')]
        .filter((el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()))
        .filter((el) => {
          const style = getComputedStyle(el);
          const clips = style.textOverflow === 'ellipsis' || style.overflow === 'hidden';
          return el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > edge + 0.5 || (clips && el.scrollWidth > el.clientWidth);
        })
        .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}: ${el.textContent?.slice(0, 40)}`);
    });
    expect.soft(cut, 'no text cut off or past the panel').toEqual([]);
  });
