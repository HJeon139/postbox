// The composer’s quota line (#442, designs/architecture/adapters.md, “Quota: each backend’s usage, in the composer”):
// one bar per backend the room’s agents run on, with its most-used window and reset time, labeled by backend and never
// in an agent’s row. A backend that reports no quota gets no bar; a stale figure says its age; a window past its reset
// shows no number; a hint that applies takes the line. Figures are made up: recorded ones stay scrubbed.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced, windowWidth } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const HOUR = 3_600_000;
const resetsAt = Date.now() + 3 * HOUR;
test.beforeAll(async () => {
  app = await startPostbox('quota-line');
  // Fake harnesses: Claude Code and Codex report a quota with each turn, as theirs do; Kiro reports none.
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
  backend('codex', { status: 'ok', windows: [{ name: '7 d', used: 0.07, resetsAt }] });
  backend('kiro-cli', null);
  backend('agent-sdk', null);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

let count = 0;
/** A room with an agent on each backend, each having answered once, open at 1280 px. */
async function room(page, backends = ['claude-code', 'codex', 'kiro-cli'], width = 1280) {
  const n = ++count;
  const personas = backends.map((backend, i) => app.rt.createPersona({ handle: `q${n}x${i}`, backend }));
  const t = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Quota ${n}`, personaIds: personas.map((p) => p.id) });
  app.rt.sendMessage(t.id, { text: personas.map((p) => `@${p.handle}`).join(' ') + ' go' });
  // Each agent answered once, so each harness has had its turn to report.
  await expect.poll(() => app.store.items(t.id).filter((i) => i.kind === 'agent' && i.text === 'Done.').length).toBe(backends.length);
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  return t;
}
const line = (page) => page.locator('.composer .quota-line');
const bar = (page, backend) => line(page).getByRole('meter', { name: new RegExp(`^${backend} quota`) });

test('#442 one bar per backend in the room, with its most-used window and reset time; Kiro reports none', async ({ page }) => {
  await room(page);
  await expect(bar(page, 'Claude Code')).toHaveAttribute('aria-valuenow', '42');
  await expect(bar(page, 'Claude Code')).toHaveAttribute('aria-valuetext', /^Claude Code 42% of 5 h · resets /);
  await expect(bar(page, 'Claude Code')).toContainText('Claude Code 42%');
  await expect(bar(page, 'Codex')).toHaveAttribute('aria-valuenow', '7');
  await expect(line(page).getByRole('meter'), 'no bar for a backend that reports no quota').toHaveCount(2);
  await expect(line(page)).not.toContainText('Kiro');
  // Per backend, not per agent: the agents’ rows show no quota figure.
  await expect(page.locator('.agent-row')).toHaveCount(3);
  await expect(page.locator('.agent-row').filter({ hasText: '42%' })).toHaveCount(0);
});

test('#442 a room’s bars are only its own backends’', async ({ page }) => {
  await room(page, ['codex']);
  await expect(bar(page, 'Codex')).toBeVisible();
  await expect(line(page).getByRole('meter')).toHaveCount(1);
});

test('#442 a hint takes the line while you type, and the bars come back when the draft is empty', async ({ page }) => {
  await room(page);
  await expect(bar(page, 'Claude Code')).toBeVisible();
  await page.locator('#composer-input').focus();
  await page.keyboard.insertText('Is it done?');
  await expect(page.locator('.composer .hint')).toContainText('Replying to');
  await expect(line(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expect(bar(page, 'Claude Code')).toBeVisible();
});

/** Where the input card, the line, and each bar with its track and words are drawn. */
const layout = (page) =>
  page.evaluate(() => {
    const r = (/** @type {Element | null} */ el) => (el ? el.getBoundingClientRect().toJSON() : null);
    const composer = /** @type {Element} */ (document.querySelector('.main > .composer'));
    const line = composer.querySelector('.quota-line');
    const bars = [...(line?.querySelectorAll('[role="meter"]') ?? [])].map((b) => ({
      bar: r(b),
      track: r(b.querySelector('.quota-track')),
      text: r(b.querySelector('.quota-text')),
    }));
    return { composer: r(composer), card: r(composer.querySelector('.composer-box')), line: r(line), bars };
  });

test('#1463 the line spans the input card, an equal part per backend, each bar filling its part with its words below it', async ({ page }) => {
  await room(page);
  await expect(line(page).getByRole('meter')).toHaveCount(2);
  await settled(page);
  const { card, line: row, bars } = await layout(page);
  expect.soft(Math.abs(row.left - card.left), 'it starts where the card does').toBeLessThanOrEqual(0.5);
  expect.soft(Math.abs(row.right - card.right), 'and ends where it does').toBeLessThanOrEqual(0.5);
  expect.soft(Math.abs(bars[0].bar.width - bars[1].bar.width), 'two bars get half each').toBeLessThanOrEqual(1);
  expect.soft(bars[0].bar.width, 'half the card less its chevron (20 px, #1496), less the gap').toBeGreaterThan((card.width - 20) / 2 - 12);
  for (const [i, b] of bars.entries()) {
    expect.soft(b.track && Math.abs(b.track.width - b.bar.width), `bar ${i + 1}’s track fills its part`).toBeLessThanOrEqual(0.5);
    expect.soft(b.track && b.text.top >= b.track.bottom, `bar ${i + 1}’s words are below its track`).toBe(true);
  }
  expect.soft(Math.max(...bars.map((b) => b.bar.height)), 'one row of bars, as high as a hint’s').toBeLessThanOrEqual(20);
  expect.soft(row.top, 'the line covers the gap from the card down (#1463)').toBeLessThanOrEqual(card.bottom + 0.5);
});

test('#1463 the space under the input is the line’s row and no more, when a report comes after the room opens', async ({ page }) => {
  // Kiro reports nothing, so the line is empty when the room opens, and a report comes later.
  await room(page, ['kiro-cli']);
  await expect(line(page)).toBeHidden();
  const before = await layout(page);
  app.store.emit('quota', {
    id: 'kiro-cli',
    backend: 'kiro-cli',
    host: null,
    status: 'ok',
    windows: [{ name: '5 h', used: 0.3, resetsAt }],
    seenAt: Date.now(),
  });
  await expect(bar(page, 'Kiro CLI')).toBeVisible();
  await settled(page);
  const after = await layout(page);
  expect.soft(after.card.top, 'the card doesn’t move as the line comes').toBe(before.card.top);
  expect.soft(after.line.top - after.card.bottom, 'the line right under the card').toBeLessThanOrEqual(0.5);
  expect.soft(after.composer.bottom - after.line.bottom, 'and little under it').toBeLessThanOrEqual(6.5);
});

test('#442 a figure seen long ago says its age, and a window past its reset shows no number', async ({ page }) => {
  await room(page, ['claude-code', 'codex']);
  app.store.emit('quota', {
    id: 'codex',
    backend: 'codex',
    host: null,
    status: 'ok',
    windows: [{ name: '7 d', used: 0.3, resetsAt }],
    seenAt: Date.now() - 2 * HOUR,
  });
  app.store.emit('quota', {
    id: 'claude-code',
    backend: 'claude-code',
    host: null,
    status: 'ok',
    windows: [{ name: '5 h', used: 0.9, resetsAt: Date.now() - 60_000 }],
    seenAt: Date.now(),
  });
  await synced(page, app);
  await expect(bar(page, 'Codex'), 'it says its age').toHaveAttribute('aria-valuetext', /^Codex 30% of 7 d, as of 2 h ago · resets /);
  await expect(bar(page, 'Codex').locator('.quota-pct'), 'marked without color').toHaveText('~30%');
  await expect(bar(page, 'Claude Code')).toHaveAttribute('aria-valuetext', 'Claude Code · 5 h reset');
  await expect(bar(page, 'Claude Code')).not.toContainText('90%');
});

test('#442 on a phone each bar keeps its backend and percent whole, and the window and reset give way first', async ({ page }) => {
  await room(page, ['claude-code', 'codex'], 375);
  await expect(bar(page, 'Codex')).toBeVisible();
  await settled(page);
  const row = await line(page).boundingBox();
  for (const name of ['Claude Code', 'Codex']) {
    const main = await bar(page, name).locator('.quota-pct').boundingBox();
    expect(main && row && main.x >= row.x - 0.5 && main.x + main.width <= row.x + row.width + 0.5, `${name}’s percent is on the row`).toBe(true);
  }
  expect(await barsHigh(page), 'one row').toBeLessThanOrEqual(20);
});

/**
 * A room whose agents run on the given backends, a host’s by `backend@host`, with each quota record set through the
 * store (made-up figures), open at 375 px. @param {any} page @param {{ key: string, used: number, seenAgo?: number }[]} quotas
 */
async function phoneRoom(page, quotas) {
  const n = ++count;
  const personas = quotas.map(({ key }, i) => {
    const [backend, hostName] = key.split('@');
    const persona = app.rt.createPersona({ handle: `p${n}x${i}`, backend });
    if (!hostName) return { persona, backend, remote: undefined };
    // On a host, set through the store: the fake harnesses here run only on this computer.
    const remote = { hostId: app.rt.addHost({ name: hostName }).id };
    app.store.emit('persona', { ...app.store.state.personas[persona.id], remote });
    return { persona, backend, remote };
  });
  const t = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Phone ${n}`, personaIds: personas.map((p) => p.persona.id) });
  quotas.forEach(({ used, seenAgo = 0 }, i) => {
    const { backend, remote } = personas[i];
    const id = remote ? `${backend}@${remote.hostId}` : backend;
    app.store.emit('quota', {
      id,
      backend,
      host: remote?.hostId ?? null,
      status: 'ok',
      windows: [{ name: '5 h', used, resetsAt }],
      seenAt: Date.now() - seenAgo,
    });
  });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(line(page).getByRole('meter')).toHaveCount(quotas.length);
  await settled(page);
}

/** The tallest bar: the bars are one row, as high as a hint’s. */
const barsHigh = (page) =>
  line(page)
    .getByRole('meter')
    .evaluateAll((els) => Math.max(...els.map((el) => el.getBoundingClientRect().height)));

/** On one row, inside the line: no bar overlaps the next, each keeps its backend and percent whole, nothing scrolls. */
async function fitsThePhone(page) {
  const row = await line(page).boundingBox();
  const bars = await line(page)
    .getByRole('meter')
    .evaluateAll((els) =>
      els.map((el) => {
        const b = el.getBoundingClientRect();
        const m = /** @type {HTMLElement} */ (el.querySelector('.quota-pct')).getBoundingClientRect();
        return { left: b.left, right: b.right, mainLeft: m.left, mainRight: m.right, text: el.getAttribute('aria-valuetext') };
      }),
    );
  for (const [i, b] of bars.entries()) {
    expect.soft(row && b.left >= row.x - 0.5 && b.right <= row.x + row.width + 0.5, `${b.text}: inside the line`).toBe(true);
    expect.soft(b.mainLeft >= b.left - 0.5 && b.mainRight <= b.right + 0.5, `${b.text}: its backend and percent are whole`).toBe(true);
    if (i) expect.soft(b.left >= bars[i - 1].right - 0.5, `${b.text}: clear of the bar before`).toBe(true);
  }
  expect.soft(await barsHigh(page), 'one row').toBeLessThanOrEqual(20);
  const wide = await line(page).evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect.soft(wide[0], 'the line doesn’t overflow').toBeLessThanOrEqual(wide[1]);
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), 'the page doesn’t scroll sideways').toBeLessThanOrEqual(windowWidth(page));
}

test('#442 at 375 px three backends share the line, each with its backend and percent whole', async ({ page }) => {
  await phoneRoom(page, [
    { key: 'claude-code', used: 0.42 },
    { key: 'agent-sdk', used: 0.42 },
    { key: 'codex', used: 0.07 },
  ]);
  await fitsThePhone(page);
});

test('#442 at 375 px two stale bars fit, their age giving way before their percent', async ({ page }) => {
  await phoneRoom(page, [
    { key: 'claude-code', used: 0.42, seenAgo: 2 * HOUR },
    { key: 'codex', used: 0.07, seenAgo: 3 * HOUR },
  ]);
  await fitsThePhone(page);
});

test('#442 at 375 px an agent on a host with a long name fits, its host name giving way first', async ({ page }) => {
  await phoneRoom(page, [
    { key: 'claude-code@build-workstation-in-the-basement', used: 0.88, seenAgo: 3 * HOUR },
    { key: 'codex', used: 0.07 },
  ]);
  await expect(bar(page, 'Claude Code on build-workstation-in-the-basement')).toBeVisible();
  await fitsThePhone(page);
});
