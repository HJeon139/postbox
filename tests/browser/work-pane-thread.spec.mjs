// A thread in the right pane goes full screen in place (#132), keeping its draft, its scroll and a streaming reply, and
// comes back as it was, by Escape or the icon; a reload restores it. Read a little way up from the end, it keeps its
// place too (#837). At 1280 and at 375 px, on the demo’s “Citation fixes” (tests/browser/work-pane.mjs). Moved from
// tools/check-work-pane.mjs (#303), beside work-pane.spec.mjs.

import { expect, test } from '@playwright/test';
import { probe } from './debug-probe.mjs';
import { failOnPageErrors, settled } from './postbox.mjs';
import { citationFixes, hash, noSideways, SIZES, THREAD } from './work-pane.mjs';

/** @type {Awaited<ReturnType<typeof citationFixes>>} */
let ctx;
let app;
let topic;
test.beforeAll(async () => {
  // Two of the mock’s turns of work, which take up to a minute each on a busy computer.
  test.setTimeout(150_000);
  ctx = await citationFixes('work-pane-thread');
  ({ app, topic } = ctx);
});
test.afterAll(async () => {
  await ctx?.stop();
});
failOnPageErrors(test);
// Light, as the old check ran it.
test.use({ colorScheme: 'light' });

const open = (page, r) => ctx.open(page, r);

// What the transcript holds in place when its size changes: the message across the middle of the view (#162).
const reading = (page) =>
  page.locator(`${THREAD} .sp-body`).evaluate((s) => {
    const box = s.getBoundingClientRect();
    const mid = box.top + s.clientHeight / 2;
    const items = [...s.querySelectorAll('.transcript > [data-key]')].filter((n) => n.getBoundingClientRect().bottom > box.top);
    const it = /** @type {HTMLElement} */ (items.find((n) => n.getBoundingClientRect().bottom > mid) ?? items.at(-1));
    return { key: it.dataset.key ?? '', top: Math.round(it.getBoundingClientRect().top - box.top) };
  });
/** Once the page holds still, that the message read before is where it was, within 3 px. */
async function stillAt(page, was, what) {
  await settled(page);
  const top = await page
    .locator(`[data-key="${was.key}"]`)
    .evaluate((n, s) => Math.round(n.getBoundingClientRect().top - (document.querySelector(s)?.getBoundingClientRect().top ?? 0)), `${THREAD} .sp-body`);
  expect(Math.abs(top - was.top), what).toBeLessThanOrEqual(3);
}

/**
 * Opens the thread beside Work with a draft in its composer, scrolled up to the middle by the wheel, as a person
 * scrolls, so there’s more than a window’s worth below. Marks its nodes, to tell them from a rebuilt copy.
 */
async function threadWithDraft(page) {
  await open(page, `/side/${topic}?work`);
  const body = page.locator(`${THREAD} .sp-body`);
  const ta = page.locator(`${THREAD} .composer textarea`);
  const marked = [body, ta, page.locator(THREAD)];
  for (const l of marked)
    await l.evaluate((n) => {
      n.dataset.same = 'yes';
    });
  await ta.fill('');
  await ta.focus();
  await page.keyboard.insertText('A draft reply');
  const b = await body.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -300);
  await settled(page);
  return { ta, marked, icon: page.locator('#thread-full') };
}

/** the thread goes full screen in place, keeping its draft and its scroll, and comes back as it was */
async function threadFull(page, { width, height }) {
  const { ta, marked, icon } = await threadWithDraft(page);
  const before = await reading(page);
  await icon.click();
  await expect(page.locator('.sidepanel.pane-full')).toBeVisible();
  expect(await hash(page)).toMatch(/[?&]full=thread\b/);
  await expect(icon).toBeFocused();
  await expect(icon).toHaveAttribute('aria-label', 'Exit full screen');
  for (const l of marked) await expect(l, 'the same node, not a rebuilt one').toHaveAttribute('data-same', 'yes');
  await expect(ta).toHaveValue('A draft reply');
  const r = await page.locator('.sidepanel.pane-full').boundingBox();
  expect([r.width, r.height], 'the window').toEqual([width, height]);
  // At the message column’s width.
  const col = Math.round((await page.locator('.sidepanel.pane-full .sp-body .transcript').boundingBox()).width);
  expect(col <= 760 && col >= Math.min(760, width - 48), `the column is ${col} px`).toBe(true);
  // The message you were reading starts where it did, though the wider column makes it shorter.
  await stillAt(page, before, 'the message you were reading stayed put');
  await noSideways(page, 'with the thread full screen');
  // Escape brings it back to the pane, with focus on the icon, the draft and the transcript as they were.
  const last = await reading(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pane-full')).toHaveCount(0);
  await expect(icon).toBeFocused();
  await expect(ta).toHaveAttribute('data-same', 'yes');
  await expect(ta).toHaveValue('A draft reply');
  await stillAt(page, last, 'back in the pane, the message you were reading stayed put');
}

/** Where the thread’s scroll box is: how far from its end, and whether it follows the end or holds a place. */
const place = (page) =>
  page.locator(`${THREAD} .sp-body`).evaluate((b) => ({
    gap: Math.round(b.scrollHeight - b.clientHeight - b.scrollTop),
    mode: /** @type {HTMLElement} */ (b.querySelector('.transcript'))?.dataset.viewMode ?? '',
  }));

/**
 * #837: read a little way up from the end, a few hundred px, the full screen’s shorter content clamps the view to its
 * end, and that used to start following, so back in the pane the thread jumped to its end. It keeps its place now.
 */
async function threadNearEnd(page, _size, { lateScroll = false } = {}) {
  await open(page, `/side/${topic}?work`);
  const body = page.locator(`${THREAD} .sp-body`);
  await settled(page);
  const b = await body.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let i = 0; i < 40 && (await place(page)).gap < 400; i++) {
    await page.mouse.wheel(0, -100);
    await settled(page);
  }
  const before = await place(page);
  // It really scrolled up, and holds a place: a check that can fail.
  expect(before.gap, 'scrolled up from the end').toBeGreaterThanOrEqual(400);
  expect(before.mode).toBe('reading');
  // The order the Mac showed about 1 run in 10: the clamp’s scroll event comes after the view has handled the resize.
  // A capturing listener on the window holds the box’s next scroll event for two frames, then sends it on.
  if (lateScroll)
    await body.evaluate((box) => {
      const hold = (/** @type {Event} */ e) => {
        if (e.target !== box || !e.isTrusted) return;
        e.stopImmediatePropagation();
        removeEventListener('scroll', hold, true);
        requestAnimationFrame(() => requestAnimationFrame(() => box.dispatchEvent(new Event('scroll'))));
      };
      addEventListener('scroll', hold, true);
    });
  await page.locator('#thread-full').click();
  await expect(page.locator('.sidepanel.pane-full')).toBeVisible();
  await settled(page);
  expect((await place(page)).mode, 'full screen, still reading, not following').toBe('reading');
  await page.keyboard.press('Escape');
  await expect(page.locator('.pane-full')).toHaveCount(0);
  await settled(page);
  const after = await place(page);
  expect(after.mode, 'back in the pane, still reading').toBe('reading');
  expect(Math.abs(after.gap - before.gap), `the gap to the end, ${before.gap} px before and ${after.gap} px after`).toBeLessThanOrEqual(3);
}

/**
 * #837’s guard can’t take your own scroll for the box’s: after the window grows with no scroll event, one wheel to the
 * end is you reaching it, so the thread follows the end again and stays there when the window shrinks back.
 */
async function threadEndAfterGrow(page, { width, height }) {
  await open(page, `/side/${topic}?work`);
  const body = page.locator(`${THREAD} .sp-body`);
  await settled(page);
  const b = await body.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let i = 0; i < 40 && (await place(page)).gap < 400; i++) {
    await page.mouse.wheel(0, -100);
    await settled(page);
  }
  expect((await place(page)).mode, 'reading, a way up from the end').toBe('reading');
  await page.setViewportSize({ width, height: height + 100 });
  await settled(page);
  await page.mouse.wheel(0, 5000);
  await settled(page);
  expect(await place(page), 'one wheel to the end follows it').toEqual({ gap: 0, mode: 'following' });
  await page.setViewportSize({ width, height });
  await settled(page);
  expect(await place(page), 'and still follows it once the window is back').toEqual({ gap: 0, mode: 'following' });
}

/** #837’s other side: following the end, full screen and back still follows it. */
async function threadFollows(page) {
  await probe(page);
  await open(page, `/side/${topic}?work`);
  await settled(page);
  const pl = await place(page);
  console.log('VIEWPORT', JSON.stringify(await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, scale: visualViewport?.scale, ih: innerHeight, top: [...document.querySelectorAll('.topbar, .topbar *')].map((e) => [e.className, Math.round(e.getBoundingClientRect().right)]).filter(([, r]) => r > 375).slice(0, 8) }))));
  if (pl.mode !== 'following')
    console.log(
      'VLOG',
      JSON.stringify(pl),
      JSON.stringify(
        await page.evaluate(() => [
          window.__vlog,
          document.querySelector('.topbar')?.outerHTML.length,
          document.querySelector('.topbar')?.getBoundingClientRect().height,
        ]),
      ),
    );
  expect(pl.mode, 'opened at the end').toBe('following');
  await page.locator('#thread-full').click();
  await expect(page.locator('.sidepanel.pane-full')).toBeVisible();
  await settled(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pane-full')).toHaveCount(0);
  await settled(page);
  expect(await place(page)).toEqual({ gap: 0, mode: 'following' });
}

/**
 * #837’s guard holds a place you scrolled to, not one the view guessed. The transcript shrinking and growing back in
 * one frame moves the view up before its scroll event arrives, which reads as your scroll (#341), so the view stops
 * following. The box growing next clamps it back to the end, and that follows again, as it did before #837’s guard.
 */
async function threadGuessedThenClamped(page, { width, height }) {
  await open(page, `/side/${topic}?work`);
  const body = page.locator(`${THREAD} .sp-body`);
  await settled(page);
  expect((await place(page)).mode, 'opened at the end').toBe('following');
  await body.evaluate((box) => {
    const last = /** @type {HTMLElement} */ ([...box.querySelectorAll('.transcript > [data-key]')].at(-1));
    const was = last.getBoundingClientRect().height;
    last.style.height = `${Math.max(0, was - 40)}px`;
    void box.scrollTop; // the layout that clamps the view, before the transcript grows back
    last.style.height = `${was + 20}px`;
  });
  await settled(page);
  await page.setViewportSize({ width, height: height + 100 });
  await settled(page);
  expect(await place(page), 'the box grew, and the clamp to the end follows it').toEqual({ gap: 0, mode: 'following' });
}

/** a reply streams into the thread full screen and stays when it comes back; the icon and a reload restore it */
async function threadStreams(page) {
  // The mock’s reply can take most of 30 s on a busy computer.
  test.setTimeout(60_000);
  const { rt, store } = app;
  const { ta, icon } = await threadWithDraft(page);
  await icon.click();
  await expect(page.locator('.sidepanel.pane-full')).toBeVisible();
  // A reply streams in while it’s full screen, into the same transcript.
  const n = store.items(topic).length;
  rt.sendMessage(topic, { text: 'One more thing on the side' });
  const replyOf = () =>
    store
      .items(topic)
      .slice(n)
      .find((i) => i.kind === 'agent');
  await expect.poll(() => !!replyOf(), { message: 'the reply to start' }).toBe(true);
  const id = replyOf().id;
  await expect(page.locator(`.sidepanel.pane-full [data-key="${id}"]`), 'the reply, full screen').toBeAttached();
  await expect.poll(() => replyOf().status, { message: 'the reply to finish', timeout: 30_000 }).toBe('done');
  await expect(page.locator(`.sidepanel.pane-full [data-key="${id}"]`), 'the reply finished, full screen').toContainText(replyOf().text.slice(-12));
  // Escape brings it back to the pane, the draft and the transcript as they were: the message in view stays put.
  await settled(page);
  const last = await reading(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pane-full')).toHaveCount(0);
  await expect(icon).toBeFocused();
  // The same composer, not a rebuilt one that brought the draft back from where drafts are kept.
  await expect(ta).toHaveAttribute('data-same', 'yes');
  await expect(ta).toHaveValue('A draft reply');
  await stillAt(page, last, 'back in the pane, the message you were reading stayed put');
  await expect(page.locator(`.sidepanel [data-key="${id}"]`), 'the reply stayed').toBeAttached();
  // The icon brings it back too.
  await icon.click();
  await expect(page.locator('.sidepanel.pane-full')).toBeVisible();
  await icon.click();
  await expect(page.locator('.pane-full')).toHaveCount(0);
  await expect(icon).toBeFocused();
  // A reload restores it.
  await icon.click();
  await expect(page.locator('.sidepanel.pane-full')).toBeVisible();
  await page.reload();
  await expect(page.locator('.sidepanel.pane-full .sp-body .transcript [data-key]').first(), 'the thread full screen, after the reload').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pane-full')).toHaveCount(0);
  await expect(icon).toBeFocused();
}

/** Each test, by name, run at each width. */
const CASES = [
  ['the thread goes full screen in place, keeping its draft and its scroll, and comes back as it was', threadFull],
  ['a reply streams into the thread full screen and stays when it comes back; the icon and a reload restore it', threadStreams],
  ['read a little way up from the end, full screen and back keeps the place (#837)', threadNearEnd],
  ['following the end, full screen and back still follows it (#837)', threadFollows],
  ['after the window grows, one wheel to the end follows it (#837)', threadEndAfterGrow],
  ['a stop of following the view guessed, then the box growing to the end, follows it again (#837)', threadGuessedThenClamped],
  [
    'read a little way up, the clamp’s scroll event late, full screen and back keeps the place (#837)',
    (page, size) => threadNearEnd(page, size, { lateScroll: true }),
  ],
];

for (const { width, height, phone } of SIZES)
  test.describe(`${width} px`, () => {
    test.use(phone ? { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width, height } });
    for (const [name, run] of CASES) test(`${width} px: ${name}`, ({ page }) => run(page, { width, height, phone }));
  });
