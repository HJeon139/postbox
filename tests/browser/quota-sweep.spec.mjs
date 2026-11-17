// The quota line at every width (#442): from 320 to 1280 px in 4 px steps, with one to four bars at 100%, fresh and
// stale, each bar’s percent stays whole inside it, no two bars show the same label, a stale bar is marked without
// color (“~”), and nothing overflows. The bars give way in the order the design gives: the track, then short names,
// then the percent alone (designs/architecture/adapters.md, “Quota: each backend’s usage, in the composer”).

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const HOUR = 3_600_000;
const HOST = 'build-workstation-in-the-basement';
test.beforeAll(async () => {
  app = await startPostbox('quota-sweep');
  for (const name of ['claude-code', 'agent-sdk', 'codex']) arrange.withAdapter(app.rt, { name, folderFor: async () => app.root, async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

// The widest case: Claude Code, the Agent SDK and Codex here, and Claude Code again on a host with a long name.
const ALL = [{ backend: 'claude-code' }, { backend: 'agent-sdk' }, { backend: 'codex' }, { backend: 'claude-code', host: HOST }];
let count = 0;

/** A room with the first n of ALL, each at 100%, stale where stale(i) says, open in the page. */
async function room(page, n, stale) {
  const k = ++count;
  const ids = ALL.slice(0, n).map(({ backend, host }, i) => {
    const persona = app.rt.createPersona({ handle: `s${k}x${i}`, backend });
    let id = backend;
    let hostId = null;
    if (host) {
      // On a host, set through the store: the fake harnesses here run only on this computer.
      hostId = app.rt.addHost({ name: host }).id;
      app.store.emit('persona', { ...app.store.state.personas[persona.id], remote: { hostId } });
      id = `${backend}@${hostId}`;
    }
    const seenAt = Date.now() - (stale(i) ? 3 * HOUR : 0);
    app.store.emit('quota', { id, backend, host: hostId, status: 'ok', windows: [{ name: '5 h', used: 1, resetsAt: Date.now() + 3 * HOUR, seenAt }], seenAt });
    return persona.id;
  });
  const t = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Sweep ${k}`, personaIds: ids });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('.composer .quota-line').getByRole('meter')).toHaveCount(n);
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
    const names = [];
    for (const bar of line.querySelectorAll('[role="meter"]')) {
      const b = bar.getBoundingClientRect();
      const pct = /** @type {HTMLElement} */ (bar.querySelector('.quota-pct'));
      const p = pct.getBoundingClientRect();
      const label = bar.getAttribute('aria-label');
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

for (const [n, which, stale] of /** @type {[number, string, (i: number) => boolean][]} */ ([
  [1, 'fresh', () => false],
  [1, 'stale', () => true],
  [2, 'fresh and stale', (i) => i % 2 === 1],
  [3, 'fresh and stale', (i) => i % 2 === 1],
  [4, 'fresh and stale', (i) => i % 2 === 1],
]))
  test(`#442 ${n} bar${n > 1 ? 's' : ''} at 100%, ${which}, fit every width from 320 to 1280 px`, async ({ page }) => {
    test.setTimeout(120_000);
    await room(page, n, stale);
    const found = [];
    for (let width = 320; width <= 1280; width += 4) {
      await page.setViewportSize({ width, height: 800 });
      await frames(page);
      await frames(page);
      for (const p of await problems(page)) found.push(`${width} px: ${p}`);
    }
    expect(found.slice(0, 20), `${found.length} problems`).toEqual([]);
  });
