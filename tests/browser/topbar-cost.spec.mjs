// The top bar is rebuilt only when what it shows changes (#986). Any conversation’s `thread` event rebuilt the open
// conversation’s bar, and fitting the new bar (fitTopbar, shell.mjs) read its width, which lays out the whole page.
// A burst of another conversation’s events, delivered before a frame, cost one forced layout each. Chromium counts the
// page’s layouts (the DevTools protocol’s Performance.getMetrics, LayoutCount). The guards change each part the bar
// shows, in turn, and the bar follows.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

const BURST = 50;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let persona;
let other;
test.beforeAll(async () => {
  app = await startPostbox('topbar-cost');
  persona = app.rt.createPersona({ handle: 'shelver' });
  other = app.rt.createPersona({ handle: 'binder' });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

let n = 0;
const projectId = () => Object.values(app.rt.s.projects)[0].id;
/** Two conversations in the project, the first open in the page, its top bar marked. */
async function twoOpen(page) {
  const { rt } = app;
  const open = rt.createThread({ projectId: projectId(), title: `Open ${++n}`, personaIds: [persona.id] });
  const elsewhere = rt.createThread({ projectId: projectId(), title: `Elsewhere ${n}`, personaIds: [persona.id] });
  await page.goto(`${app.origin}/#/t/${open.id}`);
  await synced(page, app);
  await settled(page);
  await mark(page);
  return { open, elsewhere };
}
/** Marks the top bar, so a rebuilt one is a new element without it. */
const mark = (page) =>
  page.locator('header.topbar').evaluate((bar) => {
    bar.dataset.same = 'yes';
  });
const kept = (page) => page.locator('header.topbar[data-same="yes"]').count();
async function layoutCount(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'LayoutCount').value;
}

test('#986 another conversation’s events don’t rebuild the open one’s top bar, or lay out the page for it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the layout count comes from Chromium’s DevTools protocol');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const { elsewhere } = await twoOpen(page);
  const before = await layoutCount(cdp);
  // Each its own event, all before the page’s next frame: a forced layout each, on main.
  for (let i = 0; i < BURST; i++) app.rt.renameThread(elsewhere.id, `Elsewhere, take ${i}`);
  await synced(page, app);
  await settled(page);
  const layouts = (await layoutCount(cdp)) - before;
  expect(await kept(page), 'the same top bar').toBe(1);
  expect(layouts, `${BURST} of another conversation’s events`).toBeLessThanOrEqual(3);
});

test('#986 renaming the open conversation still updates its title', async ({ page }) => {
  const { open } = await twoOpen(page);
  app.rt.renameThread(open.id, 'Shelving, renamed');
  await expect(page.locator('header.topbar .crumbs .title')).toHaveText('Shelving, renamed');
  expect(await kept(page), 'a new bar').toBe(0);
});

test('#986 the top bar follows its project’s name, in a conversation and on the project’s page', async ({ page }) => {
  const { open } = await twoOpen(page);
  const project = app.rt.s.projects[open.projectId];
  app.store.emit('project', { ...project, name: 'Shelf audit' });
  await expect(page.locator('header.topbar .crumbs a.crumb')).toHaveText('Shelf audit');
  await page.goto(`${app.origin}/#/p/${project.id}/threads`);
  await synced(page, app);
  await mark(page);
  app.store.emit('project', { ...project, name: 'Shelf audit, again' });
  await expect(page.locator('header.topbar .crumbs a.crumb')).toHaveText('Shelf audit, again');
  app.store.emit('project', project);
});

test('#986 the top bar follows the agents that need you', async ({ page }) => {
  const { open } = await twoOpen(page);
  const se = app.rt.sessionsIn(open.id)[0];
  for (const s of Object.values(app.store.state.sessions)) if (s.needs) app.rt.updateSession(s.id, { needs: null, state: 'idle' });
  await expect(page.locator('#next-needs')).toBeDisabled();
  app.rt.updateSession(se.id, { state: 'needs', needs: { kind: 'block', itemId: 'it_x', text: 'Which shelf?' } });
  await expect(page.locator('#next-needs')).toBeEnabled();
  app.rt.updateSession(se.id, { state: 'idle', needs: null });
});

test('#986 an agent joining the open conversation still rebuilds its view', async ({ page }) => {
  const { open } = await twoOpen(page);
  app.rt.ensureSession(open.id, other.id);
  await expect(page.locator('.rail .agent-row', { hasText: 'binder' })).toBeVisible();
  expect(await kept(page), 'a new bar').toBe(0);
});

test('#986 the places menu lists the projects as they are when it opens, though the bar wasn’t rebuilt', async ({ page }) => {
  await twoOpen(page);
  const base = Object.values(app.rt.s.projects)[0];
  const another = { ...base, id: `pr_menu${n}`, name: 'Bindery' };
  app.store.emit('project', another);
  app.store.emit('project', { ...another, name: 'Bindery, renamed' });
  await synced(page, app);
  expect(await kept(page), 'the same top bar').toBe(1);
  await page.locator('#places-button').click();
  await expect(page.locator('.menu')).toContainText('Bindery, renamed');
  await page.keyboard.press('Escape');
});
