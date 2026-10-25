// The right pane (#132, reworked from #138’s tabs):
// - a conversation’s Work and a thread open beside it alone or together, split by a divider that moves by keyboard
//   and mouse;
// - either goes full screen with the app frames’ icon and comes back with Escape or the icon, with focus on it;
// - a reply’s work line opens the pane at its turn, a reload restores what was open, and nothing scrolls sideways.
// Every test runs at 1280 and at 375 px, on the demo’s “Citation fixes” (tests/browser/work-pane.mjs). Each test opens
// the pane as it needs it; a thread full screen is in work-pane-thread.spec.mjs.
// Moved from tools/check-work-pane.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled } from './postbox.mjs';
import { citationFixes, hash, noSideways, SIZES, THREAD, WORK } from './work-pane.mjs';

/** @type {Awaited<ReturnType<typeof citationFixes>>} */
let ctx;
let app;
let conv;
let other;
let topic;
let turns;
test.beforeAll(async () => {
  // Two of the mock’s turns of work, which take up to a minute each on a busy computer.
  test.setTimeout(150_000);
  ctx = await citationFixes('work-pane');
  ({ app, conv, other, topic, turns } = ctx);
});
test.afterAll(async () => {
  await ctx?.stop();
});
failOnPageErrors(test);
// Light, as the old check ran it.
test.use({ colorScheme: 'light' });

const pane = (r) => ctx.pane(r);
const open = (page, r) => ctx.open(page, r);
const go = (page, h) => ctx.go(page, h);
const focusedId = (page) => page.evaluate(() => document.activeElement?.id ?? '');
const inside = (page, sel) => page.evaluate((s) => !!document.activeElement?.closest(s), sel);
const valueNow = (page) => page.locator('.rp-divider').getAttribute('aria-valuenow');

/** Tabs from the conversation’s composer until focus lands in what sel finds; how many presses it took, or 0. */
async function tabTo(page, sel, max = 80) {
  await page.locator('#composer-input').focus();
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press('Tab');
    if (await inside(page, sel)) return i;
  }
  return 0;
}

/** the top bar’s Work button says Work (#183), opens Work alone in the pane, and it reaches the keyboard */
async function workButton(page, { phone }) {
  await open(page, '');
  const button = page.locator('#work-button');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  // It says Work in words beside its icon (#183); on a phone only the icon shows, square, and Work is still its
  // name. It shows pressed while Work is open.
  const btn = await button.evaluate((b) => {
    const w = /** @type {Element} */ (b.querySelector('.sr-sm'));
    return {
      name: b.textContent?.trim(),
      label: b.getAttribute('aria-label'),
      icon: !!b.querySelector('.i-file'),
      word: w.getBoundingClientRect().width,
      width: b.getBoundingClientRect().width,
    };
  });
  expect([btn.name, btn.label, btn.icon]).toEqual(['Work', null, true]);
  if (!phone) expect(btn.word, '“Work” shows').toBeGreaterThan(20);
  else expect([btn.word <= 1, btn.width], '“Work” hidden on a phone, in a square button').toEqual([true, 26]);
  await button.click();
  await expect(page.locator(WORK)).toBeVisible();
  expect(await hash(page)).toBe(pane('?work'));
  await expect(page.locator(THREAD), 'no thread opened too').toHaveCount(0);
  await expect(page.locator('.rpane.split')).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  // Compact: the summary and stats, each a short list into its detail.
  for (const h of ['To review', 'Files', 'Commands', 'Outside Postbox', 'Spend', 'Turns'])
    await expect(page.locator('.wp-body h2').filter({ hasText: new RegExp(`^${h}`) }), `“${h}”`).not.toHaveCount(0);
  // Both turns ran five commands, and two failed.
  await expect(page.locator('#wc-commands-h').locator('..')).toContainText('5 commands · 2 failed');
  expect(await tabTo(page, WORK), 'Tab reaches the Work pane').toBeGreaterThan(0);
  await noSideways(page, 'with Work open');
}

/** Close shuts Work, focus goes back to the Work button, and a thread opens alone */
async function closeWork(page, { phone }) {
  await open(page, '?work');
  await page.locator('#work-close').click();
  await expect(page.locator(WORK)).toHaveCount(0);
  expect(await hash(page)).toBe(pane(''));
  if (!phone) await expect(page.locator('#work-button')).toBeFocused();
  await go(page, pane(`/side/${topic}`));
  await expect(page.locator(THREAD)).toBeVisible();
  await expect(page.locator(WORK), 'Work didn’t open with the thread').toHaveCount(0);
  expect(await tabTo(page, THREAD), 'Tab reaches the thread').toBeGreaterThan(0);
  await noSideways(page, 'with a thread open');
}

/** Work opens beside the open thread, split above it, with a divider that moves by keyboard and mouse */
async function split(page) {
  await open(page, `/side/${topic}`);
  await page.locator('#work-button').click();
  await expect(page.locator('.rpane.split')).toBeVisible();
  await expect(page.locator(WORK)).toBeVisible();
  await expect(page.locator(THREAD)).toBeVisible();
  expect(await hash(page)).toBe(pane(`/side/${topic}?work`));
  await settled(page);
  const w = await page.locator(WORK).boundingBox();
  const t = await page.locator(THREAD).boundingBox();
  expect(w.y + w.height, 'Work is above the thread').toBeLessThanOrEqual(t.y + 1);
  expect(w.height > 120 && t.height > 120, `tall enough: Work ${w.height} px, thread ${t.height} px`).toBe(true);
  // Both reach the keyboard, and so does the divider between them.
  expect(await tabTo(page, WORK), 'Tab reaches Work').toBeGreaterThan(0);
  expect(await tabTo(page, '.rp-divider'), 'Tab reaches the divider').toBeGreaterThan(0);
  expect(await tabTo(page, THREAD), 'Tab reaches the thread').toBeGreaterThan(0);
  // The keyboard moves the divider.
  await page.locator('.rp-divider').focus();
  const before = Number(await valueNow(page));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.rp-divider')).toHaveAttribute('aria-valuenow', String(before + 10));
  await expect.poll(async () => (await page.locator(WORK).boundingBox()).height, { message: 'Work grows' }).toBeGreaterThan(w.height + 20);
  await page.keyboard.press('Home');
  await expect(page.locator('.rp-divider')).toHaveAttribute('aria-valuenow', '20');
  // So does the mouse.
  await settled(page);
  const d = await page.locator('.rp-divider').boundingBox();
  const pr = await page.locator('.rpane').boundingBox();
  const x = d.x + d.width / 2;
  const y = d.y + d.height / 2;
  const toY = Math.round(pr.y + pr.height * 0.6);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 40);
  await page.mouse.move(x, toY);
  await page.mouse.up();
  await expect.poll(async () => Math.abs(Number(await valueNow(page)) - 60), { message: 'dragged to about 60' }).toBeLessThanOrEqual(3);
  await noSideways(page, 'with both open');
}

/** Work goes full screen with the app frames’ icon; Escape and the icon bring it back, with focus on the icon */
async function workFull(page, { width, height }) {
  await open(page, `/side/${topic}?work`);
  const icon = page.locator('#work-full');
  await expect(icon).toHaveAttribute('aria-label', 'Full screen');
  await icon.click();
  await expect(page.locator('.workpane.pane-full .work-view')).toBeVisible();
  expect(await hash(page)).toMatch(/[?&]full=work\b/);
  expect(await inside(page, '.workpane.pane-full'), 'focus moved into it').toBe(true);
  await expect(icon).toHaveAttribute('aria-label', 'Exit full screen');
  const r = await page.locator('.workpane.pane-full').boundingBox();
  expect([r.width, r.height], 'the window').toEqual([width, height]);
  // #138’s view, as it was.
  for (const id of ['work-files', 'work-vcs', 'work-external', 'work-commands', 'work-effort']) await expect(page.locator(`.pane-full #${id}`)).toBeAttached();
  // Tab stays in it.
  for (let i = 0; i < 30; i++) await page.keyboard.press('Tab');
  expect(await inside(page, '.workpane.pane-full'), 'Tab stayed in full screen').toBe(true);
  await noSideways(page, 'full screen');
  await page.keyboard.press('Escape');
  await expect(page.locator('.pane-full')).toHaveCount(0);
  await expect(icon).toBeFocused();
  expect(await hash(page)).not.toMatch(/full/);
  await expect(page.locator('.wp-body .wc-sec').first(), 'the compact form came back').toBeVisible();
  // The icon, now “Exit full screen”, does the same.
  await icon.click();
  await expect(page.locator('.workpane.pane-full')).toBeVisible();
  await icon.click();
  await expect(page.locator('.pane-full')).toHaveCount(0);
  await expect(icon).toBeFocused();
}

/** an item in the pane opens full screen at that item */
async function itemFull(page) {
  await open(page, `/side/${topic}?work`);
  const file = app.store.state.work[conv.id].find((e) => e.kind === 'file' && e.rel?.endsWith('refs.bib'));
  // Its Files row, as the old check took it, or its To review row where it has none.
  const files = page.locator(`#wc-file-${file.id}`);
  await ((await files.count()) ? files : page.locator(`#wc-review-${file.id}`)).focus();
  const id = await focusedId(page);
  await page.keyboard.press('Enter');
  await expect(page.locator(`.pane-full details[open] > summary#wsum-${file.id}`), 'refs.bib, opened').toBeFocused();
  await expect(page.locator('.pane-full .work-diff').first(), 'its diff').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pane-full')).toHaveCount(0);
  // Back to the item you chose.
  await expect.poll(() => focusedId(page)).toBe(id);
}

/** a reply’s work line opens Work at its turn, beside the thread */
async function workLine(page, { phone }) {
  await open(page, `/side/${topic}?work`);
  await page.locator('#work-close').click();
  await expect(page.locator(WORK)).toHaveCount(0);
  const second = turns[1];
  const chip = page.locator(`.transcript .work-chip[href*="turn=${second.id}"]`);
  await expect(chip, 'the second reply’s work line').toBeAttached();
  // At 375 the thread covers the conversation: close it to reach the line, as a person would.
  if (phone) {
    await page.locator(`${THREAD} .sp-head button[aria-label="Close thread"]`).click();
    await expect(page.locator(THREAD)).toHaveCount(0);
  }
  await chip.click();
  const turn = page.locator(`#wturn-${second.id}`);
  await expect(page.locator(`#wturn-${second.id}[open].is-target`), 'the turn, opened').toBeVisible();
  expect(await hash(page)).toBe(phone ? pane(`?work&turn=${second.id}`) : pane(`/side/${topic}?work&turn=${second.id}`));
  await expect(turn.locator('> summary'), 'focus on the turn').toBeFocused();
  await settled(page);
  const seen = await page.evaluate((id) => {
    const b = /** @type {Element} */ (document.querySelector('.wp-body')).getBoundingClientRect();
    const t = /** @type {Element} */ (document.querySelector(`#wturn-${id}`)).getBoundingClientRect();
    return t.top >= b.top - 1 && t.top < b.bottom - 20;
  }, second.id);
  expect(seen, 'the turn is scrolled into view').toBe(true);
  await expect(turn).toContainText('1 command (1 failed)');
  // Its own lines go on to that turn alone, expanded.
  await page.locator(`#wc-open-${second.id}`).click();
  await expect(page.locator('.pane-full .work-turn'), 'one turn, full screen').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pane-full')).toHaveCount(0);
  await noSideways(page, 'at a turn');
}

/** a reload restores what was open, and the conversation keeps Work open until it’s closed */
async function reload(page, { phone }) {
  await open(page, `/side/${topic}?work`);
  await page.locator('.rp-divider').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.rp-divider')).toHaveAttribute('aria-valuenow', '25');
  await page.reload();
  await expect(page.locator('.rpane.split')).toBeVisible();
  await expect(page.locator(WORK)).toBeVisible();
  await expect(page.locator(THREAD)).toBeVisible();
  await expect(page.locator('.rp-divider')).toHaveAttribute('aria-valuenow', '25');
  // Full screen, too.
  await page.locator('#work-full').click();
  await expect(page.locator('.workpane.pane-full')).toBeVisible();
  await page.reload();
  await expect(page.locator('.workpane.pane-full .work-view'), 'full screen, after the reload').toBeVisible();
  await expect(page.locator(THREAD)).toBeAttached();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pane-full')).toHaveCount(0);
  await expect(page.locator('#work-full')).toBeFocused();
  // Another conversation has nothing open; coming back, Work and the thread are open again (#122), and so for a
  // plain link to it. In a narrow window, where the pane would cover it, the conversation opens on its own.
  await go(page, `#/t/${other.id}`);
  await expect(page.locator('.rpane:not([hidden])')).toHaveCount(0);
  await go(page, pane(''));
  if (!phone) {
    await expect(page.locator(WORK)).toBeVisible();
    await expect(page.locator(THREAD)).toBeVisible();
    expect(await hash(page)).toBe(pane(`/side/${topic}?work`));
  } else {
    expect(await hash(page)).toBe(pane(''));
    await expect(page.locator('.rpane:not([hidden])'), 'the pane doesn’t cover the conversation').toHaveCount(0);
  }
}

/** #138’s Work page links open the pane */
async function oldLinks(page) {
  await open(page, '');
  await go(page, pane('/work'));
  await expect.poll(() => hash(page), { message: 'the redirect' }).toBe(pane('?work'));
  await go(page, pane(`/work/${turns[0].id}`));
  await expect.poll(() => hash(page), { message: 'the turn’s redirect' }).toBe(pane(`?work&turn=${turns[0].id}`));
  await expect(page.locator(`#wturn-${turns[0].id}[open]`)).toBeVisible();
  await expect(page.locator('nav.conv-tabs'), 'no tabs').toHaveCount(0);
  // Only a view that’s open goes full screen: with no thread, no thread full screen.
  await go(page, pane('?full=thread'));
  await expect(page.locator('.pane-full'), 'nothing went full screen').toHaveCount(0);
  await noSideways(page, 'after the redirect');
}

/** Each test, by name, run at each width. */
const CASES = [
  ['the top bar’s Work button says Work (#183), opens Work alone in the pane, and it reaches the keyboard', workButton],
  ['Close shuts Work, focus goes back to the Work button, and a thread opens alone', closeWork],
  ['Work opens beside the open thread, split above it, with a divider that moves by keyboard and mouse', split],
  ['Work goes full screen with the app frames’ icon; Escape and the icon bring it back, with focus on the icon', workFull],
  ['an item in the pane opens full screen at that item', itemFull],
  ['a reply’s work line opens Work at its turn, beside the thread', workLine],
  ['a reload restores what was open, and the conversation keeps Work open until it’s closed', reload],
  ['#138’s Work page links open the pane', oldLinks],
];

for (const { width, height, phone } of SIZES)
  test.describe(`${width} px`, () => {
    test.use(phone ? { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width, height } });
    for (const [name, run] of CASES) test(`${width} px: ${name}`, ({ page }) => run(page, { width, height, phone }));
  });
