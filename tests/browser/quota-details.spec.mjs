// The quota line’s words fit and its details open (#1496): each bar says its backend, percent and window and no more,
// so a third of the card holds it whole, and keeps its full words in its title; the rest, every window’s figure, reset
// and when it was updated, is in Settings › Backends, which a click on a bar, or the chevron at the line’s end, opens,
// and which stays current while it’s open. Figures are made up: recorded ones stay scrubbed.

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

test('#1496 a click on a bar opens Settings › Backends, with each window’s figure, reset and age', async ({ page }) => {
  await room(page);
  await bar(page, 'Codex').click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('tab', { name: 'Backends' })).toHaveAttribute('aria-selected', 'true');
  const claude = settings.getByRole('table', { name: 'Claude Code quota' });
  await expect(claude.getByRole('row')).toHaveCount(3);
  await expect(claude.getByRole('row').nth(1)).toContainText(/5 h\s*42%\s*\d+:\d\d [ap]m\s*1 min ago/);
  await expect(claude.getByRole('row').nth(2)).toContainText(/7 d\s*10%\s*\w{3} \d+:\d\d [ap]m/);
  await expect(settings.getByRole('table', { name: 'Codex quota' })).toContainText(/7 d \(GPT-5\)\s*7%/);
  await expect(settings, 'a backend that reports none says so').toContainText('Kiro CLI reports no quota.');
});

test('#1496 the line’s details open from the keyboard too, by a chevron you can see', async ({ page }) => {
  await room(page);
  const open = line(page).getByRole('button', { name: 'Quota details' });
  await expect(open, 'a cue on a touch screen too, where nothing hovers').toBeVisible();
  const box = await open.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(12);
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('tab', { name: 'Backends' })).toHaveAttribute('aria-selected', 'true');
});

test('#1496 a bar’s title is still the pointer’s: nothing covers the bars, and the title says the rest', async ({ page }) => {
  await room(page);
  const b = await bar(page, 'Codex').boundingBox();
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="meter"]')?.getAttribute('aria-label') ?? null, {
    x: (b?.x ?? 0) + (b?.width ?? 0) / 2,
    y: (b?.y ?? 0) + (b?.height ?? 0) / 2,
  });
  expect(hit, 'the bar is what the pointer is on').toBe('Codex quota');
  await expect(bar(page, 'Codex')).toHaveAttribute('title', /^Codex 7% of 7 d \(GPT-5\) · resets /);
});

test('#1496 the table says a stale window’s age, a window past its reset, and a host’s quota on its own', async ({ page }) => {
  await room(page);
  const host = app.rt.addHost({ name: 'build-box' }).id;
  app.store.emit('quota', {
    id: `claude-code@${host}`,
    backend: 'claude-code',
    host,
    status: 'ok',
    // The first window has no time of its own, so it’s as old as its record; the second is past its reset.
    windows: [
      { name: '5 h', used: 0.3, resetsAt },
      { name: '7 d', used: 0.6, resetsAt: Date.now() - 60_000, seenAt: Date.now() - 3 * HOUR },
    ],
    seenAt: Date.now() - 2 * HOUR,
  });
  await synced(page, app);
  await bar(page, 'Codex').click();
  const there = page.getByRole('dialog', { name: 'Settings' }).getByRole('table', { name: 'Claude Code on build-box quota' });
  await expect(there.getByRole('row').nth(1)).toContainText(/5 h\s*30%\s*\d+:\d\d [ap]m\s*2 h ago/);
  await expect(there.getByRole('row').nth(2), 'past its reset: no figure, no reset time').toHaveText(/^7 d\s*Reset\s*3 h ago$/);
});

test('#1496 the table stays current while it’s open, and focus stays where it was', async ({ page }) => {
  await room(page);
  await bar(page, 'Codex').click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const codex = settings.getByRole('table', { name: 'Codex quota' });
  await expect(codex).toContainText(/7 d \(GPT-5\)\s*7%/);
  const tab = settings.getByRole('tab', { name: 'Backends' });
  await tab.focus();
  app.store.emit('quota', { ...app.store.state.quota.codex, windows: [{ ...app.store.state.quota.codex.windows[0], used: 0.88 }], seenAt: Date.now() });
  await synced(page, app);
  await expect(codex).toContainText(/7 d \(GPT-5\)\s*88%/);
  await expect(tab).toBeFocused();
});

test('#1496 at 375 px no word in the table breaks across lines but a window’s name, and nothing runs out of its cell', async ({ page }) => {
  await room(page, 375);
  const host = app.rt.addHost({ name: 'phone-box' }).id;
  app.store.emit('quota', {
    id: `claude-code@${host}`,
    backend: 'claude-code',
    host,
    status: 'ok',
    windows: [
      { name: '5 h', used: 0.3, resetsAt: Date.now() + 30 * HOUR },
      { name: '7 d', used: 0.6, resetsAt: Date.now() - 60_000 },
    ],
    seenAt: Date.now() - 2 * HOUR,
  });
  await synced(page, app);
  await line(page).getByRole('button', { name: 'Quota details' }).click();
  const tables = page.getByRole('dialog', { name: 'Settings' }).locator('.quota-table');
  await expect(tables.first()).toBeVisible();
  const broken = await tables.evaluateAll((all) =>
    all.flatMap((table) =>
      [...table.querySelectorAll('th:not(:first-child), td:not(:first-child)')].flatMap((cell) => {
        const text = cell.firstChild;
        if (!(text instanceof Text)) return [];
        const out = [];
        const box = cell.getBoundingClientRect();
        for (const m of text.data.matchAll(/\S+/g)) {
          const r = document.createRange();
          r.setStart(text, m.index ?? 0);
          r.setEnd(text, (m.index ?? 0) + m[0].length);
          const rects = [...r.getClientRects()];
          if (rects.length > 1) out.push(`${m[0]} breaks`);
          if (rects.some((x) => x.right > box.right + 0.5)) out.push(`${m[0]} runs out of its cell`);
        }
        return out;
      }),
    ),
  );
  expect(broken).toEqual([]);
});

test('#1496 the chevron takes 20 px from the bars, as quota-fit is told (OPEN_W), at 1280 and 375 px', async ({ page }) => {
  for (const width of [1280, 375]) {
    await room(page, width);
    await expect(line(page).getByRole('meter')).toHaveCount(2);
    const gap = await line(page).evaluate((el) => {
      const bars = [...el.querySelectorAll('.quota-bar')];
      return el.getBoundingClientRect().right - bars[bars.length - 1].getBoundingClientRect().right;
    });
    expect.soft(Math.abs(gap - 20), `at ${width} px the bars end ${gap} px short of the line`).toBeLessThanOrEqual(0.5);
  }
});
