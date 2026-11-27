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

test('#1735 Settings takes the full height on every tab, so switching tabs moves no tab', async ({ page }) => {
  const persona = started.app.rt.createPersona({ handle: 'fits', backend: 'claude-code' });
  await page.goto(`${started.app.origin}/`);
  await synced(page, started.app);
  await page.evaluate(() => import('/app/js/sheets.mjs').then((m) => m.openSettings('appearance')));
  const dialog = page.getByRole('dialog');
  const height = () => dialog.evaluate((d) => d.getBoundingClientRect().height);
  const tabsTop = () => dialog.getByRole('tablist').evaluate((t) => t.getBoundingClientRect().top);
  const room = await page.evaluate(() => innerHeight - 32);
  await settled(page);
  const top = await tabsTop();
  for (const name of ['Appearance', 'Profile', 'Personas', 'Projects', 'Hosts', 'Backends']) {
    await dialog.getByRole('tab', { name }).click();
    await settled(page);
    expect(Math.abs((await height()) - room), `${name} takes the full height`).toBeLessThanOrEqual(1);
    expect(await tabsTop(), `the tabs stay where they were on ${name}`).toBe(top);
  }
  await dialog.getByRole('tab', { name: 'Personas' }).click();
  await dialog.locator('li[role="option"]', { hasText: 'fits' }).click();
  await dialog.locator(`#pe-edit-${persona.id}`).click();
  await settled(page);
  expect(Math.abs((await height()) - room), 'a persona’s form takes the full height').toBeLessThanOrEqual(1);
  expect(await tabsTop(), 'the tabs stay where they were on a persona’s form').toBe(top);
  // Its actions are under the form, not in it: in view however long the form is.
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole('button', { name: 'Delete…', exact: true })).toBeInViewport({ ratio: 1 });
});

// A quick press comes with its move, with no frame between (#1632): the sheet took what to hold only in the next frame,
// so content that grew above a control in its body in that frame moved it from under the press. Save and Create agent
// are in the sheet’s foot, which nothing above moves; a skill’s checkbox is in the body. The press now takes hold at once.
test('#1632 a skill’s checkbox, pressed as it’s reached, stays under the press while the sheet grows above it', async ({ page }) => {
  const persona = started.app.rt.createPersona({ handle: 'quick-press', backend: 'claude-code' });
  const lists = await lateLists(page);
  await page.goto(`${started.app.origin}/`);
  await synced(page, started.app);
  await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', id)), persona.id);
  await expect.poll(lists.asked, { message: 'the sheet to ask for both lists' }).toBe(2);
  lists.letGo();
  const box = page.getByRole('checkbox', { name: /skill-12/ });
  // As in a browser with no scroll anchoring of its own (Safari), where only the sheet’s hold keeps it.
  await page.addStyleTag({ content: '.d-body { overflow-anchor: none; }' });
  await box.scrollIntoViewIfNeeded();
  await settled(page);
  const { pressedAt, at } = await box.evaluate((b) => {
    const r = b.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerType: 'mouse', isPrimary: true };
    b.dispatchEvent(new PointerEvent('pointermove', at));
    b.dispatchEvent(new PointerEvent('pointerdown', at));
    const first = /** @type {HTMLElement} */ (b.closest('.d-body')?.firstElementChild);
    // Grown in place, as a list that takes its “Looking for…” line’s place does: the sheet finds what it holds by its place.
    first.style.paddingTop = '160px';
    return { pressedAt: r.top, at };
  });
  await settled(page);
  const top = await box.evaluate((b) => b.getBoundingClientRect().top);
  expect(Math.abs(top - pressedAt), `the checkbox is ${top - pressedAt} px from the press`).toBeLessThan(1);
  const under = await page.evaluate(({ clientX, clientY }) => document.elementFromPoint(clientX, clientY)?.closest('[role="checkbox"]')?.textContent ?? '', at);
  expect(under, 'the skill is still under the press').toMatch(/skill-12/);
});

// #1884’s rule in the sheet: a frame after the pointer moves or the window loses focus, the sheet held what was under
// the pointer without taking in a scroll of its body it hadn’t heard of yet, and pulled the body back. The scroll is a
// write in a frame callback ahead of the one the blur asks for.
test('#1884 a scroll of the sheet’s body in the frame the window loses focus stands', async ({ page }) => {
  const persona = started.app.rt.createPersona({ handle: 'scroll-blur', backend: 'claude-code' });
  const lists = await lateLists(page);
  await page.goto(`${started.app.origin}/`);
  await synced(page, started.app);
  await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', id)), persona.id);
  await expect.poll(lists.asked, { message: 'the sheet to ask for both lists' }).toBe(2);
  lists.letGo();
  const box = page.getByRole('checkbox', { name: /skill-1\b/ });
  await page.addStyleTag({ content: '.d-body { overflow-anchor: none; }' });
  await box.scrollIntoViewIfNeeded();
  await settled(page);
  const r = await box.evaluate((b) => b.getBoundingClientRect());
  await page.mouse.move(r.left + r.width / 2, r.top + r.height / 2);
  await settled(page);
  const body = page.getByRole('dialog').locator('.d-body');
  const from = await body.evaluate((b) => {
    const top = b.scrollTop;
    const step = Math.min(120, b.scrollHeight - b.clientHeight - top);
    requestAnimationFrame(() => {
      b.scrollTop = top + step;
    });
    dispatchEvent(new Event('blur'));
    return { top, step };
  });
  expect(from.step, 'room to scroll the body').toBeGreaterThan(20);
  await settled(page);
  expect(await body.evaluate((b) => b.scrollTop), 'where the scroll took the body').toBe(from.top + from.step);
});
