// The quota line’s words fit and its details open (#1496): each bar says its backend, percent and window and no more,
// so a third of the card holds it whole; the rest, every window’s figure, reset and age, is in Settings › Backends,
// which a click on the line, or Enter on it, opens. Figures are made up: recorded ones stay scrubbed.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const HOUR = 3_600_000;
const resetsAt = Date.now() + 3 * HOUR;
test.beforeAll(async () => {
  app = await startPostbox('quota-details');
  // Fake harnesses: Claude Code reports two windows with each turn, Codex one, and Kiro none.
  const backend = (name, quota) =>
    arrange.withAdapter(app.rt, {
      name,
      folderFor: async () => app.root,
      async deliver(_session, _message, ctx) {
        if (quota) ctx.quota?.(quota);
        ctx.text('Done.');
      },
    });
  backend('claude-code', {
    status: 'ok',
    windows: [
      { name: '5 h', used: 0.42, resetsAt },
      { name: '7 d', used: 0.1, resetsAt: resetsAt + 24 * HOUR },
    ],
  });
  backend('codex', { status: 'ok', windows: [{ name: '7 d', used: 0.07, resetsAt, limit: 'GPT-5', limitName: 'GPT-5' }] });
  backend('kiro-cli', null);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

let count = 0;
/** A room with an agent on each of three backends, each having answered once, open at the given width. */
async function room(page, width = 1280) {
  const n = ++count;
  const personas = ['claude-code', 'codex', 'kiro-cli'].map((backend, i) => app.rt.createPersona({ handle: `d${n}x${i}`, backend }));
  const t = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Details ${n}`, personaIds: personas.map((p) => p.id) });
  app.rt.sendMessage(t.id, { text: `${personas.map((p) => `@${p.handle}`).join(' ')} go` });
  await expect.poll(() => app.store.items(t.id).filter((i) => i.kind === 'agent' && i.text === 'Done.').length).toBe(3);
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
}
const line = (page) => page.locator('.composer .quota-line');
const bar = (page, backend) => line(page).getByRole('meter', { name: new RegExp(`^${backend} quota`) });

test('#1496 a bar says its backend, percent and window, whole; a screen reader still hears the reset', async ({ page }) => {
  await room(page);
  await expect(bar(page, 'Claude Code').locator('.quota-text')).toHaveText('Claude Code 42% of 5 h');
  await expect(bar(page, 'Codex').locator('.quota-text')).toHaveText('Codex 7% of 7 d');
  await expect(bar(page, 'Claude Code')).toHaveAttribute('aria-valuetext', /^Claude Code 42% of 5 h · resets /);
  const cut = await line(page)
    .locator('.quota-text')
    .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
  expect(cut, 'no bar’s words run past its part').toEqual([]);
});

test('#1496 a click on the line opens Settings › Backends, with each window’s figure, reset and age', async ({ page }) => {
  await room(page);
  await line(page).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('tab', { name: 'Backends' })).toHaveAttribute('aria-selected', 'true');
  const claude = settings.getByRole('table', { name: 'Claude Code quota' });
  await expect(claude.getByRole('row')).toHaveCount(3);
  await expect(claude.getByRole('row').nth(1)).toContainText(/5 h\s*42%\s*\d+:\d\d [ap]m\s*1 min ago/);
  await expect(claude.getByRole('row').nth(2)).toContainText(/7 d\s*10%\s*\w{3} \d+:\d\d [ap]m/);
  await expect(settings.getByRole('table', { name: 'Codex quota' })).toContainText(/7 d \(GPT-5\)\s*7%/);
  await expect(settings, 'a backend that reports none says so').toContainText('Kiro CLI reports no quota.');
});

test('#1496 the line’s details open from the keyboard too', async ({ page }) => {
  await room(page);
  const open = line(page).getByRole('button', { name: 'Quota details' });
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('tab', { name: 'Backends' })).toHaveAttribute('aria-selected', 'true');
});
