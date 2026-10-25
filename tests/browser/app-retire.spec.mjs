// #193: an app its agent retired shows as one line where it was, with no sandbox. The line says who retired it and
// why, its link scrolls to the app that replaced it, and its version menu opens a version read-only, which Close puts
// back. Retiring moves nothing, and a new version brings the app back. Moved from tools/checks/app-retire.mjs (#303).
// One story, in steps that build on each other; each finding is soft, so a run reports all of them.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const APP = (label) => `<main style="padding:12px"><p>${label}</p><button class="btn" type="button">Try it</button></main>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-retire');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** What every step reads: the page, the runtime, the two agents’ tools, and helpers for an app's item in the transcript. */
async function seed(page) {
  const { rt, store } = app;
  const projectId = Object.values(rt.s.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Retire check', personaIds: [rt.personaByHandle('researcher').id, rt.personaByHandle('critic').id] });
  const [mine, theirs] = rt.sessionsIn(t.id).map((se) => rt.toolsFor(se.id));
  const item = (id) => page.locator(`.transcript > [data-key="${rt.s.apps[id].itemId}"]`);
  const checked = (...ids) =>
    expect
      .poll(() => ids.every((id) => rt.s.apps[id].check.status === 'passed'), { message: `${ids.join(' and ')} to pass their checks`, timeout: 15_000 })
      .toBe(true);
  await page.goto(app.origin);
  mine.show_app({ id: 'lab', title: 'Practice lab', code: APP('Lab v1') });
  mine.update_app({ id: 'lab', code: APP('Lab v2'), summary: 'more exercises' });
  for (let i = 0; i < 12; i++) rt.addItem(t.id, { kind: 'user', text: `Message ${i}, so the map is off screen from the lab.` });
  theirs.show_app({ id: 'metro', title: 'Metro map', code: APP('The map') });
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await checked('lab', 'metro');
  await expect(item('lab').locator('iframe.app-iframe'), 'the lab’s frame').toBeAttached();
  return { page, rt, store, t, mine, item, checked };
}

async function retire({ page, store, t, mine, item }) {
  const before = store.items(t.id).map((x) => x.id);
  const r = mine.retire_app({ id: 'lab', reason: 'The metro map covers the same route.', replacedBy: 'metro' });
  expect.soft(r.ok, `retire_app retires the agent’s own app: ${r.message}`).toBe(true);
  expect
    .soft(
      store.items(t.id).map((x) => x.id),
      'retiring moves nothing in the conversation',
    )
    .toEqual(before);
  await synced(page, app);
  const line = item('lab').locator('.app-retired');
  await expect(line).toBeVisible();
  await expect.soft(item('lab'), 'the line says who retired it and why').toContainText('Practice lab');
  await expect.soft(item('lab')).toContainText('Retired by @researcher: The metro map covers the same route.');
  await expect.soft(item('lab').locator('iframe'), 'a retired app runs no sandbox').toHaveCount(0);
  expect.soft((await line.boundingBox())?.height ?? 0, 'the line is one quiet line, not an app frame').toBeLessThan(40);
}

async function narrow({ page, item }) {
  await page.setViewportSize({ width: 375, height: 800 });
  const fits = () =>
    item('lab')
      .locator('.app-retired')
      .evaluate((l) => l.scrollWidth <= l.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth);
  await expect.soft(() => expect(fits()).resolves.toBe(true), 'the line and the page fit 375 px').toPass({ timeout: 5_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function link({ item }) {
  const onScreen = (id) =>
    item(id).evaluate((n) => {
      const r = n.getBoundingClientRect();
      return r.top < innerHeight && r.bottom > 0;
    });
  await item('lab').scrollIntoViewIfNeeded();
  await expect(() => expect(onScreen('metro')).resolves.toBe(false), 'the map starts off screen').toPass({ timeout: 5_000 });
  await item('lab').getByRole('button', { name: 'Go to Metro map' }).click();
  await expect.soft(() => expect(onScreen('metro')).resolves.toBe(true), 'Go to Metro map scrolls to the replacement').toPass({ timeout: 5_000 });
  expect.soft(await item('metro').evaluate((n) => n.contains(document.activeElement)), 'and focus goes there').toBe(true);
}

/** Opens one version from the retired line’s version menu, checks its note, and closes it. */
async function openVersion({ page, item }, version, note) {
  await item('lab').locator('.app-retired [aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: new RegExp(`^v${version}\\b`) }).click();
  await expect(item('lab').locator('iframe.app-iframe'), `v${version}’s frame`).toBeAttached();
  await expect.soft(item('lab').locator('.app-note'), `v${version} opens read-only, with Close`).toContainText(note);
  await item('lab').locator('.app-note').getByRole('button', { name: 'Close' }).click();
  await expect(item('lab').locator('.app-retired')).toBeVisible();
}

async function versions(ctx) {
  const { page, item } = ctx;
  await item('lab').locator('.app-retired [aria-haspopup="menu"]').click();
  await expect.soft(page.locator('.versions [role="menuitem"]'), 'the menu keeps both versions').toHaveCount(2);
  // Closed with Escape, then opened again: a menu closed that fast once left a listener behind that closed every later
  // menu on the press that picks an item (ui.mjs, openMenu).
  await page.keyboard.press('Escape');
  await openVersion(ctx, 1, /Viewing v1, read-only[\s\S]*Close/);
  await expect.soft(item('lab').locator('iframe'), 'Close puts the line back, with no frame').toHaveCount(0);
  await expect.soft(item('lab').locator('.app-retired [aria-haspopup]'), 'with focus on its version menu').toBeFocused();
  // The current version opens read-only too.
  await openVersion(ctx, 2, 'Viewing v2, read-only');
}

async function early({ page, rt, mine, item }) {
  mine.show_app({ id: 'early', title: 'Early draft', code: APP('Draft') });
  mine.retire_app({ id: 'early', reason: 'Replaced before it was shown.' });
  await synced(page, app);
  await expect(item('early').locator('.app-retired')).toBeVisible();
  await expect(page.locator('iframe.check-frame[title="Checking Early draft"]'), 'no check frame for the early draft').toHaveCount(0);
  expect.soft(rt.s.apps.early.check.status, 'its check never ran').toBe('pending');
  await expect.soft(item('early').locator('iframe')).toHaveCount(0);
  await page.reload();
  await expect
    .soft(item('early'), 'after a reload, the retired apps are still their lines')
    .toContainText('Retired by @researcher: Replaced before it was shown.');
  await expect.soft(item('lab').locator('iframe')).toHaveCount(0);
}

async function comesBack({ page, rt, store, t, mine, item, checked }) {
  const u = mine.update_app({ id: 'lab', code: APP('Lab v3'), summary: 'the route in the lab' });
  expect
    .soft(u.ok && store.items(t.id).at(-1).id === rt.s.apps.lab.itemId, `update_app brings a retired app back at the newest point: ${u.message}`)
    .toBe(true);
  await synced(page, app);
  await checked('lab');
  await expect(item('lab').locator('iframe.app-iframe'), 'v3’s frame').toBeAttached();
  await expect.soft(item('lab').locator('.app-retired'), 'and its line is gone').toHaveCount(0);
}

test('#193 a retired app is one line, links to its replacement, opens old versions read-only, and comes back with a new one', async ({ page }) => {
  const ctx = await seed(page);
  await test.step('retiring leaves one line where the app was, with no frame, and moves nothing', () => retire(ctx));
  await test.step('at 375 px the line fits its column', () => narrow(ctx));
  await test.step('its link scrolls to the app that replaced it, and moves focus there', () => link(ctx));
  await test.step('the version menu opens a version read-only, and Close puts the line back', () => versions(ctx));
  await test.step('an app retired before its check finishes stays a line, unchecked, after a reload too', () => early(ctx));
  await test.step('a new version brings it back, at the newest point', () => comesBack(ctx));
});
