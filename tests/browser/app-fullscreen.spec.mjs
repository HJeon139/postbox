// An agent app’s full-screen button fills the window with the app, without reloading it, and Escape (pressed on the
// page or inside the app) brings it back, with focus on the button (#45). With real input, each test on a conversation
// and apps of its own. Moved from tools/checks/app-fullscreen.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

// Counts its loads in saved state, so a reload shows up as a second load, and saves which version loaded.
const APP = (
  label,
) => `<main style="padding:12px"><button id="b" class="btn" type="button" style="display:block;width:100%;height:80px">${label}</button></main>
<script>
postbox.ready.then((r) => { if (!postbox.check) postbox.saveState({ loads: ((r.state && r.state.loads) || 0) + 1, label: '${label}' }); });
</script>`;
// Grows to 1200 px when you press its button.
const GROW = `<main style="padding:12px"><button id="g" class="btn" type="button" style="display:block;width:100%;height:80px">Grow</button><div id="x"></div></main>
<script>document.getElementById('g').addEventListener('click', () => { document.getElementById('x').style.height = '1200px'; });</script>`;
// Uses Escape itself (to close its own menu, say), and says so with preventDefault.
const OWN_ESCAPE = `<main style="padding:12px"><button class="btn" type="button" style="display:block;width:100%;height:80px">Has its own Escape</button></main>
<script>addEventListener('keydown', (e) => { if (e.key === 'Escape') e.preventDefault(); });</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let speed;
test.beforeAll(async () => {
  speed = process.env.POSTBOX_MOCK_SPEED;
  process.env.POSTBOX_MOCK_SPEED = '0.1';
  app = await startPostbox('app-fullscreen');
});
test.afterAll(async () => {
  await app?.stop();
  if (speed === undefined) delete process.env.POSTBOX_MOCK_SPEED;
  else process.env.POSTBOX_MOCK_SPEED = speed;
});
failOnPageErrors(test);
test.use({ colorScheme: 'dark' });

/** A conversation of its own with @librarian, open in the page; show() has it show an app and waits for it to load. */
async function conversation(page, title) {
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title, personaIds: [rt.personaByHandle('librarian').id] });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const checked = (id) => expect.poll(() => rt.s.apps[id]?.check.status, { message: `${id} to pass its check` }).toMatch(/^(passed|note)$/);
  /** Shows an app, named for this conversation, and waits for its frame to load. Returns its id. */
  const show = async (key, appTitle, code) => {
    const id = `${key}-${t.id}`;
    tools.show_app({ id, title: appTitle, code, permissions: [] });
    await checked(id);
    await expect(boxOf(page, appTitle).locator('iframe.app-iframe')).toHaveAttribute('data-sized', '1');
    return id;
  };
  return { t, tools, show, checked };
}
const boxOf = (page, title) => page.locator('.appframe').filter({ has: page.locator('.title', { hasText: new RegExp(`^${title}$`) }) });
const fullButton = (box) => box.locator('.app-bar button.icon').first();
const overlay = (page) => page.locator('.fullscreen');
/** The app’s own document, through its frame. */
const contentOf = async (box) => {
  const frame = await (await box.locator('iframe.app-iframe').elementHandle())?.contentFrame();
  if (!frame) throw new Error('The app’s frame has no document to read');
  return frame;
};
/**
 * A real click on a button inside an app. A frame takes no pointer events until the page sees the pointer over it (#38),
 * so the pointer goes over the frame first, and the click waits for the frame to turn live.
 */
async function clickInApp(box, button) {
  const f = box.locator('iframe.app-iframe');
  await f.hover();
  await expect(f, 'the frame live under the pointer').toHaveClass(/\blive\b/);
  await box.frameLocator('iframe.app-iframe').locator(button).click();
}
const frameBox = (box) =>
  box
    .locator('iframe.app-iframe')
    .evaluate((f) => ({ w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height, W: innerWidth, H: innerHeight }));

/** A conversation with an app at its second version, which counts its loads; returns it once its first load is saved. */
async function twoVersions(page, title) {
  const { rt } = app;
  const c = await conversation(page, title);
  const id = `full-${c.t.id}`;
  c.tools.show_app({ id, title: 'Full', code: APP('Version one'), permissions: [] });
  await c.checked(id);
  c.tools.update_app({ id, code: APP('Version two') });
  await expect.poll(() => rt.s.apps[id].current, { message: 'v2' }).toBe(2);
  await c.checked(id);
  const box = boxOf(page, 'Full');
  await expect(box.locator('iframe.app-iframe')).toHaveAttribute('data-sized', '1');
  // Version one’s frame can load and save before version two reaches the page: wait for version two’s own load.
  await expect.poll(() => rt.s.apps[id]?.state?.label, { message: 'version two to save its load' }).toBe('Version two');
  await box.scrollIntoViewIfNeeded();
  await settled(page);
  return { ...c, id, box, loads: () => rt.s.apps[id]?.state?.loads ?? 0 };
}

test('#45 full screen fills the window, with the version menu above it, and Escape brings it back, focus on the button', async ({ page }) => {
  const { box } = await twoVersions(page, 'Full screen');
  const button = fullButton(box);
  const before = await frameBox(box);
  await test.step('a real click on Full screen fills the window, focus in the overlay, one copy running', async () => {
    await expect(button).toHaveAttribute('aria-label', 'Full screen');
    await button.click();
    await expect(overlay(page).locator('.appframe')).toBeVisible();
    await settled(page);
    const full = await frameBox(box);
    expect(
      full.w >= 0.9 * full.W && full.h >= 0.9 * full.H,
      `the frame fills at least 90% of the window: ${Math.round(full.w)}×${Math.round(full.h)} of ${full.W}×${full.H}`,
    ).toBe(true);
    expect(await page.evaluate(() => !!document.activeElement?.closest('.fullscreen')), 'focus moves into the overlay').toBe(true);
    await expect(button).toHaveAttribute('aria-label', 'Exit full screen');
    await expect(page.locator('iframe.app-iframe'), 'no second copy of the app runs').toHaveCount(1);
  });
  await test.step('the version menu shows above the overlay, and Escape closes the menu first', async () => {
    await overlay(page).locator('.appframe [aria-haspopup="menu"]').click();
    const menu = page.locator('.menu');
    await expect(menu).toBeVisible();
    const onTop = await menu.evaluate((m) => {
      const b = m.getBoundingClientRect();
      return m.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
    });
    expect(onTop, 'the menu is on top').toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(overlay(page).locator('.appframe'), 'still full screen').toBeVisible();
  });
  await test.step('Escape leaves full screen, back to its size, with focus on the button', async () => {
    await button.focus();
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toHaveCount(0);
    await settled(page);
    const after = await frameBox(box);
    expect(Math.abs(after.h - before.h) < 2 && Math.abs(after.w - before.w) < 2, `the frame is back to its size in the column: ${after.w}×${after.h}`).toBe(
      true,
    );
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-label', 'Full screen');
  });
});

test('#45 Escape inside the app, and Enter on the button, leave full screen too, and the app never reloads', async ({ page }) => {
  const { box, loads } = await twoVersions(page, 'No reload');
  const button = fullButton(box);
  const loaded = loads();
  // Marked in its window: a reload would make a new one.
  await (await contentOf(box)).evaluate(() => {
    /** @type {any} */ (window).marked = true;
  });
  await test.step('Escape pressed inside the app leaves full screen too, with focus back on the button', async () => {
    await button.click();
    await expect(overlay(page)).toBeVisible();
    await clickInApp(box, '#b');
    await expect(box.locator('iframe.app-iframe'), 'focus in the app').toBeFocused();
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toHaveCount(0);
    await expect(button).toBeFocused();
  });
  await test.step('Enter on the button opens and closes full screen', async () => {
    await page.keyboard.press('Enter');
    await expect(overlay(page)).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(overlay(page)).toHaveCount(0);
  });
  expect(await (await contentOf(box)).evaluate(() => /** @type {any} */ (window).marked), 'the app never reloaded').toBe(true);
  expect(loads(), 'its saved state counted one load').toBe(loaded);
});

test('#45 switching versions while full screen re-renders the app in place, still full screen, with focus kept in it', async ({ page }) => {
  const { box } = await twoVersions(page, 'Versions');
  const button = fullButton(box);
  await button.click();
  await overlay(page).locator('.appframe [aria-haspopup="menu"]').click();
  await page.locator('.menu .mi', { hasText: /^v1/ }).click();
  await expect(overlay(page).locator('.app-note'), 'v1 shows').toBeVisible();
  await expect(overlay(page)).toContainText('Viewing v1');
  await settled(page);
  const v1 = await frameBox(box);
  expect(v1.h, 'an older version opens in the same full-screen view').toBeGreaterThanOrEqual(0.8 * v1.H);
  expect(await page.evaluate(() => !!document.activeElement?.closest('.fullscreen')), 'focus stays in the overlay after the switch').toBe(true);
  // Tab past the last control comes back into the overlay.
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.fullscreen')), 'Tab keeps focus inside the overlay').toBe(true);
  await button.focus();
  await page.keyboard.press('Escape');
  await expect(overlay(page), 'Escape still leaves full screen after the switch').toHaveCount(0);
});

test('#45 an app that grew while full screen comes back as tall as the column allows', async ({ page }) => {
  const { show } = await conversation(page, 'Grows');
  await show('grow', 'Grow', GROW);
  const box = boxOf(page, 'Grow');
  await box.scrollIntoViewIfNeeded();
  await fullButton(box).click();
  await expect(overlay(page)).toBeVisible();
  await clickInApp(box, '#g');
  await expect((await contentOf(box)).locator('#x'), 'the app grew').toHaveCSS('height', '1200px');
  await fullButton(box).focus();
  await page.keyboard.press('Escape');
  await expect(overlay(page)).toHaveCount(0);
  // Not its old height: the app measures again once it’s back in the column.
  await expect
    .poll(() => box.locator('iframe.app-iframe').evaluate((f) => Math.abs(f.getBoundingClientRect().height - Math.min(innerHeight * 0.8, 760))), {
      message: 'as tall as the column allows',
    })
    .toBeLessThan(2);
});

test('#45 Escape an app handles itself doesn’t leave full screen', async ({ page }) => {
  const { show } = await conversation(page, 'Own escape');
  await show('own-escape', 'Own escape', OWN_ESCAPE);
  const box = boxOf(page, 'Own escape');
  await box.scrollIntoViewIfNeeded();
  await fullButton(box).click();
  await expect(overlay(page)).toBeVisible();
  await clickInApp(box, 'button');
  await expect(box.locator('iframe.app-iframe'), 'focus in the app').toBeFocused();
  await page.keyboard.press('Escape');
  // The app’s kit tells the page of an Escape it didn’t handle a task later, so after two of its frames and two of the
  // page’s, any such message has come.
  await (await contentOf(box)).evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await frames(page);
  await expect(overlay(page), 'still full screen').toBeVisible();
  await fullButton(box).focus();
  await page.keyboard.press('Escape');
  await expect(overlay(page)).toHaveCount(0);
});

test('#45 full screen ends with its view: back in the conversation, it isn’t full screen, and Escape elsewhere isn’t taken by it', async ({ page }) => {
  const { t, show } = await conversation(page, 'Leaves');
  const other = await conversation(page, 'Elsewhere');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await show('grow', 'Grow', GROW);
  const box = boxOf(page, 'Grow');
  /** Goes to a conversation by its address, as its link does, and waits for its view. */
  const go = async (id) => {
    await synced(page, app);
    await page.evaluate((h) => {
      location.hash = h;
    }, `#/t/${id}`);
    await expect(page.locator(`#main[data-thread="${id}"]`)).toBeVisible();
    await settled(page);
  };
  await box.scrollIntoViewIfNeeded();
  await fullButton(box).click();
  await expect(overlay(page)).toBeVisible();
  await go(other.t.id);
  await go(t.id);
  await expect(box.locator('iframe.app-iframe')).toHaveAttribute('data-sized', '1');
  await frames(page);
  await expect(overlay(page), 'coming back doesn’t open the app full screen').toHaveCount(0);
  // Full screen again, then away: Escape on the other page isn’t taken by a full screen that’s gone.
  await box.scrollIntoViewIfNeeded();
  await fullButton(box).click();
  await expect(overlay(page)).toBeVisible();
  await go(other.t.id);
  await page.evaluate(() => {
    /** @type {any} */ (window).esc = null;
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') /** @type {any} */ (window).esc = e.defaultPrevented;
    });
    /** @type {HTMLElement | null} */ (document.activeElement)?.blur();
  });
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).esc), { message: 'Escape heard, and not taken' }).toBe(false);
});
