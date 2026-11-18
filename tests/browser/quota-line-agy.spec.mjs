// Antigravity’s bar on the composer’s quota line (#1466, designs/architecture/adapters.md, “Quota: each backend’s usage,
// in the composer”): from agy’s /usage, its most-used pool named after the window. Moved from quota-line.spec.mjs,
// which was at its size. Figures are made up.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const resetsAt = Date.now() + 3 * 3_600_000;
test.beforeAll(async () => {
  app = await startPostbox('quota-line-agy');
  for (const name of ['antigravity-cli', 'codex']) arrange.withAdapter(app.rt, { name, folderFor: async () => app.root, async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

let count = 0;
const line = (page) => page.locator('.composer .quota-line');
const bar = (page, backend) => line(page).getByRole('meter', { name: new RegExp(`^${backend} quota`) });

test('#1466 Antigravity gets a bar from its /usage, its most-used pool named after the window', async ({ page }) => {
  const n = ++count;
  const persona = app.rt.createPersona({ handle: `agy${n}`, backend: 'antigravity-cli' });
  // Beside an agent on Codex, so the line has two parts (#1463).
  const beside = app.rt.createPersona({ handle: `cx${n}`, backend: 'codex' });
  const t = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Agy ${n}`, personaIds: [persona.id, beside.id] });
  app.store.emit('quota', {
    id: 'codex',
    backend: 'codex',
    host: null,
    status: 'ok',
    windows: [{ name: '7 d', used: 0.07, resetsAt, seenAt: Date.now() }],
    seenAt: Date.now(),
  });
  // What agyQuota makes of a /usage answer where Claude and GPT models’ pool is the most used (made-up figures).
  app.store.emit('quota', {
    id: 'antigravity-cli',
    backend: 'antigravity-cli',
    host: null,
    status: 'ok',
    windows: [
      { name: '5 h', used: 0.03, resetsAt, seenAt: Date.now() },
      { name: '7 d', used: 0.4, resetsAt, limit: 'Claude and GPT models', limitName: 'Claude and GPT models', seenAt: Date.now() },
    ],
    seenAt: Date.now(),
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(bar(page, 'Antigravity CLI')).toHaveAttribute('aria-valuenow', '40');
  await expect(bar(page, 'Antigravity CLI')).toHaveAttribute('aria-valuetext', /^Antigravity CLI 40% of 7 d \(Claude and GPT models\) · resets /);
  // Laid out as every bar is: half the card beside Codex’s, its track filling its part and its words below it (#1463).
  await expect(line(page).getByRole('meter')).toHaveCount(2);
  await settled(page);
  const { card, parts, agy } = await page.evaluate(() => {
    const r = (/** @type {Element | null | undefined} */ el) => {
      if (!el) throw new Error('an element the line should hold is missing');
      return el.getBoundingClientRect().toJSON();
    };
    const meters = [...document.querySelectorAll('.composer .quota-line [role="meter"]')];
    const a = meters.find((m) => m.getAttribute('aria-label')?.startsWith('Antigravity CLI'));
    return {
      card: r(document.querySelector('.main > .composer .composer-box')),
      parts: meters.map((m) => r(m).width),
      agy: { bar: r(a), track: r(a?.querySelector('.quota-track')), text: r(a?.querySelector('.quota-text')) },
    };
  });
  expect.soft(Math.abs(parts[0] - parts[1]), 'half each').toBeLessThanOrEqual(1);
  expect.soft(agy.bar.width, 'half the card less its chevron (20 px, #1496), less the gap').toBeGreaterThan((card.width - 20) / 2 - 12);
  expect.soft(Math.abs(agy.track.width - agy.bar.width), 'its track fills its part').toBeLessThanOrEqual(0.5);
  expect.soft(agy.text.top >= agy.track.bottom, 'its words are below its track').toBe(true);
});
