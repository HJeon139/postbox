// A thread in the right pane goes full screen in place (#132), keeping its draft, its scroll and a streaming reply, and
// comes back as it was, by Escape or the icon; a reload restores it. At 1280 and at 375 px, on the demo’s “Citation
// fixes” (tests/browser/work-pane.mjs). Moved from tools/check-work-pane.mjs (#303), beside work-pane.spec.mjs.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled } from './postbox.mjs';
import { citationFixes, hash, noSideways, SIZES, THREAD } from './work-pane.mjs';

/** @type {Awaited<ReturnType<typeof citationFixes>>} */
let ctx;
let app;
let topic;
test.beforeAll(async () => {
  ctx = await citationFixes('work-pane-thread');
  ({ app, topic } = ctx);
});
test.afterAll(async () => {
  await ctx?.stop();
});
failOnPageErrors(test);

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

/** a reply streams into the thread full screen and stays when it comes back; the icon and a reload restore it */
async function threadStreams(page) {
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
];

for (const { width, height, phone } of SIZES)
  test.describe(`${width} px`, () => {
    test.use(phone ? { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width, height } });
    for (const [name, run] of CASES) test(`${width} px: ${name}`, ({ page }) => run(page, { width, height, phone }));
  });
