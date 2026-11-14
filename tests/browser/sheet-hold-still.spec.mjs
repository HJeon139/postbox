// An agent sheet that fills in late moves nothing under the pointer (#1326). The New agent sheet and a persona’s sheet
// ask for your MCP servers and the skills an agent loads once they open, and each list took the place of its
// “Looking for…” line when it came: the sheet grew, and Save or Create agent moved from under the pointer. Here both
// answers wait until the test lets them go, with lists long enough to need room.
import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, synced } from './postbox.mjs';
import { startRemote } from './remote-hosts.mjs';

/** @type {Awaited<ReturnType<typeof startRemote>>} */
let started;
test.beforeAll(async () => {
  started = await startRemote('sheet-hold-still');
});
test.afterAll(async () => {
  await started?.app.stop();
});
failOnPageErrors(test);

const SERVERS = Array.from({ length: 6 }, (_, i) => ({ name: `server-${i + 1}`, status: 'connected', scope: 'user' }));
const SKILLS = Array.from({ length: 12 }, (_, i) => ({ name: `skill-${i + 1}`, scope: 'user' }));

/** Holds the page’s asks for its MCP servers and skills until let go; returns how to let them go. */
async function lateLists(page) {
  /** @type {(() => void)[]} */
  const waiting = [];
  const hold = (/** @type {any} */ body) => async (/** @type {import('@playwright/test').Route} */ route) => {
    await new Promise((r) => waiting.push(() => r(undefined)));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  };
  await page.route('**/api/mcp-servers?*', hold({ servers: SERVERS }));
  await page.route('**/api/skills?*', hold({ skills: SKILLS }));
  return {
    asked: () => waiting.length,
    letGo: () => {
      for (const go of waiting.splice(0)) go();
    },
  };
}

/** Points at the button, lets the lists come, and says where the button went and what’s under the pointer then. */
async function pointAtWhileTheyLoad(page, button, lists) {
  await expect.poll(lists.asked, { message: 'the sheet to ask for both lists' }).toBe(2);
  await button.scrollIntoViewIfNeeded();
  await settled(page);
  const before = await button.evaluate((b) => {
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top };
  });
  await page.mouse.move(before.x, before.y);
  lists.letGo();
  await expect(page.getByRole('checkbox', { name: /skill-12/ }), 'the skills drawn').toBeAttached();
  await expect(page.getByRole('checkbox', { name: /server-6/ }), 'the servers drawn').toBeAttached();
  await settled(page);
  const top = await button.evaluate((b) => b.getBoundingClientRect().top);
  const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.textContent ?? '', [before.x, before.y]);
  return { moved: Math.abs(top - before.top), under };
}

test('#1326 a persona’s Save stays under the pointer while its MCP servers and skills load', async ({ page }) => {
  const persona = started.app.rt.createPersona({ handle: 'lists-late', backend: 'claude-code' });
  const lists = await lateLists(page);
  await page.goto(`${started.app.origin}/`);
  await synced(page, started.app);
  await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', id)), persona.id);
  const { moved, under } = await pointAtWhileTheyLoad(page, page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }), lists);
  expect.soft(moved, 'Save didn’t move').toBeLessThanOrEqual(1);
  expect.soft(under, 'Save is still under the pointer').toBe('Save');
});

test('#1326 the New agent sheet’s Create agent stays under the pointer while its MCP servers and skills load', async ({ page }) => {
  // A window tall enough for the whole sheet before its lists come, so it could grow when they do.
  await page.setViewportSize({ width: 1280, height: 1600 });
  const lists = await lateLists(page);
  await page.goto(`${started.app.origin}/`);
  await synced(page, started.app);
  await page.evaluate(() => import('/app/js/sheets.mjs').then((m) => m.openNewAgent({})));
  const create = page.getByRole('dialog').getByRole('button', { name: 'Create agent', exact: true });
  const { moved, under } = await pointAtWhileTheyLoad(page, create, lists);
  expect.soft(moved, 'Create agent didn’t move').toBeLessThanOrEqual(1);
  expect.soft(under, 'Create agent is still under the pointer').toBe('Create agent');
});
