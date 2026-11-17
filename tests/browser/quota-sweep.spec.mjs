// The quota line at every width (#442): from 320 to 1280 px in 4 px steps, with one to four bars at 100%, fresh and
// stale, each bar’s percent stays whole inside it, no two bars show the same label, a stale bar is marked without
// color (“~”), and nothing overflows. The line spans the input card, each bar’s track fills its part, and its words
// are below it (#1463). The bars give way in the order the design gives: short names, then the percent alone
// (designs/architecture/adapters.md, “Quota: each backend’s usage, in the composer”).

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const HOUR = 3_600_000;
test.beforeAll(async () => {
  app = await startPostbox('quota-sweep');
  for (const name of ['claude-code', 'agent-sdk', 'codex']) arrange.withAdapter(app.rt, { name, folderFor: async () => app.root, async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

let count = 0;

/** A bar: its backend, its host’s name if on one, its share used, and whether its figure is over an hour old. */
const bar = (backend, used, stale = false, host = null) => ({ backend, used, stale, host });
const WIDE = 'build-workstation-in-the-basement';
// Each case at 100% and at 11% and 7%, which tabular digits draw wider than a canvas measures them.
const CASES = [
  ['1 bar, fresh', [bar('claude-code', 1)]],
  ['1 bar, stale', [bar('claude-code', 1, true)]],
  ['2 bars, fresh and stale', [bar('claude-code', 1), bar('agent-sdk', 0.11, true)]],
  ['3 bars, fresh and stale', [bar('claude-code', 1), bar('agent-sdk', 0.11, true), bar('codex', 0.07)]],
  ['4 bars, one on a host with a long name', [bar('claude-code', 1), bar('agent-sdk', 0.11, true), bar('codex', 0.07), bar('claude-code', 1, true, WIDE)]],
  // Where 11% is the widest bar, so its measure decides each level.
  ['2 bars at 11% and 7%', [bar('claude-code', 0.11), bar('agent-sdk', 0.07, true)]],
  ['3 bars at 11%, 11% and 7%', [bar('claude-code', 0.11), bar('agent-sdk', 0.11, true), bar('codex', 0.07)]],
  ['two hosts whose names start alike', [bar('claude-code', 0.11, false, 'workstation-1'), bar('claude-code', 0.07, true, 'workstation-2'), bar('codex', 1)]],
];

/** A room with the given bars, each its own agent and quota record, open in the page. */
async function room(page, bars) {
  const k = ++count;
  const ids = bars.map(({ backend, host, used, stale }, i) => {
    const persona = app.rt.createPersona({ handle: `s${k}x${i}`, backend });
    let id = backend;
    let hostId = null;
    if (host) {
      // On a host, set through the store: the fake harnesses here run only on this computer.
      hostId = app.rt.addHost({ name: host }).id;
      app.store.emit('persona', { ...app.store.state.personas[persona.id], remote: { hostId } });
      id = `${backend}@${hostId}`;
    }
    const seenAt = Date.now() - (stale ? 3 * HOUR : 0);
    app.store.emit('quota', { id, backend, host: hostId, status: 'ok', windows: [{ name: '5 h', used, resetsAt: Date.now() + 3 * HOUR, seenAt }], seenAt });
    return persona.id;
  });
  const t = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Sweep ${k}`, personaIds: ids });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('.composer .quota-line').getByRole('meter')).toHaveCount(bars.length);
  return t;
}

/** What’s wrong with the line at this width, if anything. */
const problems = (page) =>
  page.evaluate(() => {
    const out = [];
    const line = /** @type {HTMLElement} */ (document.querySelector('.composer .quota-line'));
    const lineBox = line.getBoundingClientRect();
    if (line.scrollWidth > line.clientWidth) out.push(`the line overflows: ${line.scrollWidth} > ${line.clientWidth}`);
    if (document.documentElement.scrollWidth > innerWidth) out.push('the page scrolls sideways');
    if (lineBox.height > 20.5) out.push(`the line is ${lineBox.height} px high`);
    const card = /** @type {Element} */ (document.querySelector('.composer .composer-box')).getBoundingClientRect();
    if (Math.abs(lineBox.left - card.left) > 0.5 || Math.abs(lineBox.right - card.right) > 0.5) out.push('the line isn’t the card’s width');
    const names = [];
    for (const bar of line.querySelectorAll('[role="meter"]')) {
      const b = bar.getBoundingClientRect();
      const pct = /** @type {HTMLElement} */ (bar.querySelector('.quota-pct'));
      const p = pct.getBoundingClientRect();
      const label = bar.getAttribute('aria-label');
      const track = bar.querySelector('.quota-track')?.getBoundingClientRect();
      if (!track || Math.abs(track.width - b.width) > 0.5) out.push(`${label}: its track doesn’t fill its part`);
      else if (p.top < track.bottom) out.push(`${label}: its words aren’t below its track`);
      if (p.left < b.left - 0.5 || p.right > b.right + 0.5 || pct.scrollWidth > pct.clientWidth + 0.5)
        out.push(`${label}: its percent is cut (${pct.textContent})`);
      if (!/%$/.test(pct.textContent ?? '')) out.push(`${label}: no percent`);
      if (/as of/.test(bar.getAttribute('aria-valuetext') ?? '') && !pct.textContent?.startsWith('~')) out.push(`${label}: stale, with no mark`);
      const name = /** @type {HTMLElement} */ (bar.querySelector('.quota-name'));
      if (name.getBoundingClientRect().width > 0 && name.textContent?.trim()) names.push(name.textContent.trim());
    }
    if (new Set(names).size !== names.length) out.push(`two bars read the same: ${names.join(' | ')}`);
    return out;
  });

/**
 * Whether the line’s level is right, if not, why: the levels, in order, are 0 everything, 1 short names, 2 the percent
 * alone. Each shows what it says, and is used only where the one before it doesn’t fit, measured here in
 * the page’s own text.
 */
const outOfOrder = (page) =>
  page.evaluate(() => {
    const out = [];
    const line = /** @type {HTMLElement} */ (document.querySelector('.composer .quota-line'));
    const level = Number(line.dataset.fit);
    const probe = document.createElement('span');
    probe.className = 'quota-text';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    line.append(probe);
    const width = (/** @type {string} */ text) => {
      probe.textContent = text;
      return probe.getBoundingClientRect().width;
    };
    const MARGIN = 4;
    let before = true;
    for (const el of line.querySelectorAll('[role="meter"]')) {
      const [full, short] = JSON.parse(/** @type {HTMLElement} */ (el).dataset.names ?? '[]');
      const shown = el.querySelector('.quota-name')?.textContent?.trim() ?? '';
      const pct = el.querySelector('.quota-pct')?.textContent ?? '';
      const label = el.getAttribute('aria-label');
      const want = [full, short, ''][level];
      if (shown !== want) out.push(`${label}: “${shown}” at level ${level}, not “${want}”`);
      if (level === 2 && el.querySelector('.quota-more')?.textContent) out.push(`${label}: more than its percent at the last level`);
      const prev = [null, full, short][level];
      if (level > 0) {
        const name = prev;
        const need = width(`${name} ${pct}`);
        // Within MARGIN of the edge counts as not fitting: the line measures on a canvas, a little wide of the page’s
        // own text, and leaves itself room, so it gives way a few pixels early, never late.
        if (name === null || need + MARGIN > el.getBoundingClientRect().width) before = false;
      }
    }
    probe.remove();
    if (level > 0 && before) out.push(`level ${level}, though level ${level - 1} fits`);
    return out;
  });

for (const [which, bars] of CASES)
  test(`#442 ${which} fit every width from 320 to 1280 px, in order`, async ({ page }) => {
    test.setTimeout(120_000);
    await room(page, bars);
    const found = [];
    for (let width = 320; width <= 1280; width += 4) {
      await page.setViewportSize({ width, height: 800 });
      await frames(page);
      await frames(page);
      for (const p of [...(await problems(page)), ...(await outOfOrder(page))]) found.push(`${width} px: ${p}`);
    }
    expect(found.slice(0, 20), `${found.length} problems`).toEqual([]);
  });

/** Goes to a room by its address, as the rail does, and waits for its composer’s quota line. */
async function goTo(page, threadId) {
  await page.evaluate((id) => {
    location.hash = `#/t/${id}`;
  }, threadId);
  await expect(page.locator(`.composer .quota-line[data-quota-line="${threadId}"]`)).toBeAttached();
}
const observed = (page) => page.evaluate(() => import('/app/js/composer-quota.mjs').then((m) => m.observedLines()));

test('#442 a line taken off the page, as going to another room does, is no longer observed', async ({ page }) => {
  const a = await room(page, [bar('codex', 0.5)]);
  const b = await room(page, [bar('claude-code', 0.5)]);
  for (let i = 0; i < 6; i++) for (const t of [a, b]) await goTo(page, t.id);
  await frames(page);
  expect(await observed(page)).toBe(1);
});

test('#442 a line hidden when it’s taken off the page, empty or behind a hint, is let go of too', async ({ page }) => {
  const shown = await room(page, [bar('codex', 0.5)]);
  // A room whose backend has reported nothing: its line is empty, so hidden.
  const empty = app.rt.createThread({
    projectId: Object.keys(app.store.state.projects)[0],
    title: 'No report',
    personaIds: [app.rt.createPersona({ handle: `none${++count}` }).id],
  });
  // The page has the new room before its address names it.
  await synced(page, app);
  await goTo(page, shown.id);
  // A hint takes the row: the line is hidden while the draft stays.
  await page.locator('#composer-input').fill('!ls');
  await expect(page.locator('.composer .hint')).toContainText('Runs in');
  for (let i = 0; i < 12; i++) await goTo(page, (i % 2 ? shown : empty).id);
  await frames(page);
  expect(await observed(page), 'the one line on the page').toBe(1);
});
