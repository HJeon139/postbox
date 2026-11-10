// Tab through an app among skipped items (#712a). The transcript skips the items off screen (`content-visibility:
// auto`, app/workbench.css), and an app’s frame sits in one of them (app/js/apps.mjs). The browser’s own Tab order
// takes in the controls of skipped items, and draws and scrolls to the one it lands on:
// - with the app in view, Tab from the control before the frame goes into it, Tab out lands on the next control in
//   document order (the app’s own message actions, in its item), and Shift+Tab comes back in;
// - with focus in the app and the view scrolled away, so the app’s item and the ones after it are skipped, Tab out of
//   the app reaches the next control, and Tab from the app’s last control reaches the one in the skipped item below.
// The view keeps saying what the page shows throughout.

import { expect, test } from '@playwright/test';
import { frameOf } from './app-pointer.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { holds } from './view-read-fixture.mjs';
import { bigRoom, still } from './view-skipped-fixture.mjs';

// Tracing is off: Playwright’s trace snapshots walk all 1,000+ skipped items each action, and the run hangs.
test.use({ colorScheme: 'light', trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-skipped-tab');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const PAD = `<main style="padding:12px"><button id="go" type="button">Inside the pad</button></main>`;
// Tall, so the item after it starts well past the margin the browser draws ahead of the view.
const TALL = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of the long reply, which has no link in it.`).join('\n\n');

/**
 * A 1,000-item room with an app in the middle: 500 generated items, the app, a tall reply, and 500 more. Opened with
 * the app at the top of the view.
 * @param {any} page @param {string} title
 */
async function room(page, title) {
  const { rt, store } = app;
  const t = bigRoom(app, title, 500);
  const [se] = rt.sessionsIn(t.id);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(app.origin);
  await synced(page, app);
  const id = `pad-${t.id}`;
  rt.toolsFor(se.id).show_app({ id, title: 'Pad', code: PAD, permissions: [] });
  await expect.poll(() => rt.s.apps[id]?.check.status, { message: 'the pad to pass its check', timeout: 15_000 }).toMatch(/^(passed|note)$/);
  const tall = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: TALL, status: 'done' });
  for (let i = 0; i < 500; i++) rt.addItem(t.id, { kind: 'user', text: `Note ${i} after the pad.` });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  // A page opening on a thousand items under the full suite’s load can take longer than synced()’s 5 s to hear them.
  const seq = store.state.seq;
  await expect
    .poll(() => page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => client.seq)), {
      message: `the page to hear event ${seq}`,
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(seq);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] > .item`)).toHaveCount(store.items(t.id).length, { timeout: 15_000 });
  const frame = frameOf(page, 'Pad');
  // The view opens at the end, and a frame loads once it’s near the view: bring it there, then put it at the top.
  await expect(async () => {
    await frame.evaluate((n) => n.scrollIntoView({ block: 'start' }));
    await expect(frame).toHaveAttribute('data-sized', '1', { timeout: 1000 });
  }, 'the pad to load').toPass({ timeout: 15_000 });
  await frame.evaluate((n) => n.scrollIntoView({ block: 'start' }));
  await still(page);
  const item = (/** @type {string} */ key) => page.locator(`.transcript > [data-key="${key}"]`);
  return { t, frame, inside: frame.contentFrame().locator('#go'), appItem: item(rt.s.apps[id].itemId), tallItem: item(tall.id) };
}

/**
 * The first control after `from` in document order, as the browser’s Tab order finds it, with no check of whether its
 * item is drawn: its item’s key, its name, whether it’s skipped, and how many client rects it has (tabTarget’s filter,
 * app/js/apps.mjs).
 * @param {any} from a locator of the element to start after
 */
const nextAfter = (from) =>
  from.evaluate((/** @type {Element} */ f) => {
    const sel = 'a[href], button, input, select, textarea, iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
    const el = /** @type {HTMLElement | undefined} */ (
      [...document.querySelectorAll(sel)].find(
        (n) =>
          f.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING && /** @type {HTMLElement} */ (n).tabIndex >= 0 && !n.closest('[hidden], [inert]'),
      )
    );
    if (!el) return null;
    return {
      key: /** @type {HTMLElement | null} */ (el.closest('.transcript > [data-key]'))?.dataset.key ?? null,
      name: el.getAttribute('aria-label') ?? el.textContent?.trim(),
      skipped: !el.checkVisibility({ contentVisibilityAuto: true }),
      rects: el.getClientRects().length,
    };
  });

/**
 * The names of an item’s message actions, in Tab order, as nextAfter names a control: the reactions, then the thread
 * button (#378 puts the thread button on the right), whatever order the bar has.
 * @param {any} item a locator of the item
 * @returns {Promise<string[]>}
 */
const actionsOf = (item) =>
  item.evaluate((/** @type {Element} */ n) =>
    [...n.querySelectorAll('.msg-actions button, .msg-actions a[href]')].map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? ''),
  );

/** What has focus in the page: its item’s key and its name. @param {any} page */
const focused = (page) =>
  page.evaluate(() => {
    const el = /** @type {HTMLElement} */ (document.activeElement);
    const key = /** @type {HTMLElement | null} */ (el.closest('.transcript > [data-key]'))?.dataset.key ?? null;
    return { key, name: el.getAttribute('aria-label') ?? el.textContent?.trim() };
  });

/** Scrolls the page by the wheel over the top bar, so neither the frame nor an item takes it, and waits for it to hold. */
async function wheel(page, dy) {
  await page.locator('header.topbar').hover();
  await page.mouse.wheel(0, dy);
  await still(page);
}

/**
 * The pad’s focused element, read in its own document, and whether that document has focus. Tab moving focus is the
 * first; toBeFocused also needs the second, which on a Mac follows the OS window and read “inactive” with the element
 * focused (Mac checks of #712a).
 */
async function inPad(frame) {
  const pad = await (await frame.elementHandle())?.contentFrame();
  return pad ? pad.evaluate(() => ({ id: document.activeElement?.id ?? '', hasFocus: document.hasFocus() })) : { id: '', hasFocus: false };
}

test('#712a: with an app in view, Tab goes into it, out to the next control in document order, and Shift+Tab back', async ({ page, browserName }) => {
  test.fixme(browserName === 'firefox', 'Firefox leaves the app’s page unfocused every time: #906');
  const { t, frame, appItem } = await room(page, 'Tab past an app in view');
  await holds(page, t, 'with the app at the top');

  await appItem.getByRole('button', { name: 'Full screen', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(frame, 'Tab from Full screen goes into the frame').toBeFocused();
  await expect.poll(() => inPad(frame).then((p) => p.id), { message: 'focus in the pad' }).toBe('go');

  const next = await nextAfter(frame);
  const appKey = await appItem.getAttribute('data-key');
  expect
    .soft(next, 'the next control after the frame is its own message’s first action')
    .toEqual({ key: appKey, name: (await actionsOf(appItem))[0], skipped: false, rects: 1 });
  await page.keyboard.press('Tab');
  await expect.poll(() => focused(page), { message: 'Tab out of the app lands on the next control' }).toEqual({ key: next?.key, name: next?.name });
  await still(page);
  await holds(page, t, 'after Tab out of the app');

  await page.keyboard.press('Shift+Tab');
  await expect(frame, 'Shift+Tab comes back into the frame').toBeFocused();
  await expect.poll(() => inPad(frame).then((p) => p.id), { message: 'focus back in the pad' }).toBe('go');
  test.info().annotations.push({ type: 'measured', description: `the pad’s document: ${JSON.stringify(await inPad(frame))}` });
  await still(page);
  await holds(page, t, 'after Shift+Tab back into the app');
});

test('#712a: scrolled away from the app, Tab out of it and on into the skipped item below reaches each next control', async ({ page, browserName }) => {
  // In Firefox the item below the app isn’t skipped when the case checks, so it can’t show what it’s for there; and a
  // Tab from the composer at 1,000 items took 29–32 ms with skipping on, against 17–31 ms on main (Linux Firefox).
  test.fixme(browserName === 'firefox', 'the next control isn’t skipped in Firefox when checked, and the app’s page stays unfocused: #906');
  const { t, frame, inside, appItem, tallItem } = await room(page, 'Tab past an app scrolled away');
  const appKey = await appItem.getAttribute('data-key');
  // Retried: in about 4 of 20 plain full runs, the first Tab from Full screen left the pad's document inactive, and the
  // cause wasn't found in its time box. The retry may cover a defect in the page; the issue named in the PR tracks it.
  await expect(async () => {
    await appItem.getByRole('button', { name: 'Full screen', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(inside, 'focus in the pad').toBeFocused({ timeout: 1000 });
  }, 'Tab from Full screen into the pad').toPass({ timeout: 10_000 });

  await test.step('Tab out of the app, its item skipped, lands on its next control and brings it into view', async () => {
    await wheel(page, 6000);
    const next = await nextAfter(frame);
    // Behind tabTarget’s filter (app/js/apps.mjs): a control in a skipped item still has its client rect.
    expect
      .soft(next, 'the app’s next control is skipped, and has a client rect')
      .toEqual({ key: appKey, name: (await actionsOf(appItem))[0], skipped: true, rects: 1 });
    await expect(inside, 'focus is still in the pad').toBeFocused();
    await page.keyboard.press('Tab');
    await expect.poll(() => focused(page), { message: 'Tab out of the skipped app lands on its next control' }).toEqual({ key: next?.key, name: next?.name });
    await still(page);
    await expect(page.locator(':focus')).toBeInViewport();
    await holds(page, t, 'after Tab out of the skipped app');
  });

  await test.step('Tab from the app’s last control, scrolled away again, lands in the skipped item below', async () => {
    const last = appItem.locator('.msg-actions').getByRole('button', { name: /** @type {string} */ ((await actionsOf(appItem)).at(-1)), exact: true });
    await last.focus();
    await wheel(page, 6000);
    const next = await nextAfter(last);
    const tallKey = await tallItem.getAttribute('data-key');
    expect
      .soft(next, 'the next control is the tall reply’s first action, skipped')
      .toEqual({ key: tallKey, name: (await actionsOf(tallItem))[0], skipped: true, rects: 1 });
    await page.keyboard.press('Tab');
    await expect.poll(() => focused(page), { message: 'Tab lands on the control in the skipped item' }).toEqual({ key: next?.key, name: next?.name });
    await still(page);
    await expect(page.locator(':focus')).toBeInViewport();
    await holds(page, t, 'after Tab into the skipped item');
  });
});

// #712a: apps.mjs hears every Tab to see if it goes into an app frame. It read the rects of every
// focusable on the page, and over skipped items each read laid that item out: one Tab from the composer in a 1,000-item
// room took 975 layouts and about 3 s. It looks only as far as the next control now.
test('#712a: a Tab from the composer in a 1,000-item room lays out a handful of items, not the room', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the layout count comes from Chromium’s DevTools protocol');
  const t = bigRoom(app, 'Tab cost');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] > .item`)).toHaveCount(1000, { timeout: 15_000 });
  await page.locator('.composer textarea').first().focus();
  await still(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const layouts = async () => (await cdp.send('Performance.getMetrics')).metrics.find((x) => x.name === 'LayoutCount')?.value ?? 0;
  const counts = [];
  for (const key of ['Tab', 'Shift+Tab']) {
    await page.locator('.composer textarea').first().focus();
    await still(page);
    const before = await layouts();
    await page.keyboard.press(key);
    counts.push((await layouts()) - before);
  }
  test.info().annotations.push({ type: 'measured', description: `layouts for Tab, then Shift+Tab: ${counts.join(', ')}` });
  for (const n of counts) expect(n, `layouts for one key, of ${counts.join(', ')}`).toBeLessThan(20);
});
