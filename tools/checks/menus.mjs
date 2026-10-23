// A headless Chrome check that menus fit the window (#36): an app’s version menu with 30 versions is no taller than
// the window, starts inside it, scrolls, opens with the version shown in view, and clips each summary to one line;
// the shared menu’s other uses (the composer’s +, which opens above its button, and the conversation’s ⋯) still
// open whole and inside the window in a short one.
//
//   node tools/checks/menus.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory.
// PB_PORT and PB_CHROME_PORT move it (4884 and 10184 by default), so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { launch } from '../cdp.mjs';
import { finish, ports, record } from '../harness.mjs';

const { PORT, CHROME_PORT } = await ports(4884, 10184);

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-menus-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;

const settle = (ms = 250) => page.evaluate(`new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, ${ms}); })`);
async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  assert.ok(r, `Nothing to click: ${expr}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
async function pressEscape() {
  for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await settle();
}
async function check(name, fn) {
  let timer;
  try {
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 45 s')), 45000);
    });
    await Promise.race([fn(), late]);
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  } finally {
    clearTimeout(timer);
  }
  if (await page.evaluate(`!!document.querySelector('.menu')`)) await pressEscape();
}
/** The open menu’s box, how far it scrolls, and the window’s height. */
const menuBox = () =>
  page.evaluate(
    `(() => { const m = document.querySelector('.menu'); if (!m) return null; const b = m.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height, scroll: m.scrollHeight - m.clientHeight, H: innerHeight }; })()`,
  );
/** Whether the open menu sits whole inside the window, and every item in it can be reached (it isn’t clipped short). */
function fits(m, what) {
  assert.ok(m, `${what} didn’t open`);
  assert.ok(m.top >= 0 && m.bottom <= m.H, `${what} runs from ${Math.round(m.top)} to ${Math.round(m.bottom)} px in a ${m.H} px window`);
}

const project = Object.values(store.state.projects)[0];
const librarian = Object.values(store.state.personas).find((p) => p.handle === 'librarian');
const t = rt.createThread({ projectId: project.id, title: 'Many versions', personaIds: [librarian.id] });
const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
const APP = (n) => `<main style="padding:12px"><p>Version ${n}</p></main>`;
// A summary as long as an agent may write (300 characters).
const SUMMARY = (n) => `Version ${n}: ${'regrouped the pairs by author, then by year, and drew each group on its own row '.repeat(4)}`.slice(0, 300);
tools.show_app({ id: 'many', title: 'Pair explorer', code: APP(1), permissions: [] });
for (let n = 2; n <= 30; n++) tools.update_app({ id: 'many', code: APP(n), summary: SUMMARY(n) });
assert.equal(store.state.apps.many.current, 30);

await page.size(1280, 1000);
await page.goto(`${app.origin}/#/t/${t.id}`);
const VERSIONS = `document.querySelector('.appframe button[aria-haspopup=menu]')`;
await page.waitFor(`${VERSIONS}?.textContent.startsWith('v30')`, { label: 'the app at v30' });
await settle();

await check('#36 the version menu with 30 versions fits a 1,000 px window, starts inside it, and scrolls', async () => {
  await click(VERSIONS);
  const m = await menuBox();
  fits(m, 'the version menu');
  assert.ok(m.scroll > 0, 'it doesn’t scroll, so some versions can’t be reached');
  assert.equal(await page.evaluate(`document.querySelectorAll('.menu .mi').length`), 30);
});

await check('#36 each version’s summary is clipped to one line', async () => {
  await click(VERSIONS);
  const rows = await page.evaluate(
    `[...document.querySelectorAll('.menu .mi')].map((b) => { const g = b.querySelector('.grow'); return { text: b.textContent.slice(0, 12), height: b.getBoundingClientRect().height, clipped: g.scrollWidth > g.clientWidth }; })`,
  );
  // v1’s row, “v1 · first version” and the line under it, is one line of each; every other row is as tall.
  const one = rows.at(-1);
  assert.match(one.text, /^v1 · first/);
  for (const r of rows) assert.ok(r.height <= one.height + 1, `“${r.text}…” is ${r.height} px tall, and v1 ${one.height} px`);
  assert.ok(
    rows.slice(0, 29).every((r) => r.clipped),
    'a 300-character summary isn’t clipped',
  );
  const w = await page.evaluate(`document.querySelector('.menu').getBoundingClientRect().width`);
  assert.ok(w <= 420, `the menu is ${w} px wide`);
});

await check('#36 the version menu opens with the version shown focused and in view, current or older', async () => {
  // The current version, newest, is first.
  await click(VERSIONS);
  const focused = () =>
    page.evaluate(
      `(() => { const a = document.activeElement; const m = document.querySelector('.menu'); if (!m?.contains(a)) return null; const b = a.getBoundingClientRect(), mb = m.getBoundingClientRect(); return { text: a.textContent, inView: b.top >= mb.top - 1 && b.bottom <= mb.bottom + 1 }; })()`,
    );
  let f = await focused();
  assert.match(f?.text ?? '', /^v30 · Version 30/);
  assert.ok(f.inView, 'v30 is out of view');
  // An older version near the bottom: choosing it shows it, and the menu then opens on it.
  await click(`[...document.querySelectorAll('.menu .mi')].find((b) => b.textContent.startsWith('v3 · '))`);
  await page.waitFor(`!document.querySelector('.menu')`, { label: 'the menu to close' });
  await click(VERSIONS);
  f = await focused();
  assert.match(f?.text ?? '', /^v3 · Version 3/);
  assert.ok(f.inView, 'v3 is out of view');
  assert.ok((await page.evaluate(`document.querySelector('.menu').scrollTop`)) > 0, 'the menu didn’t scroll to v3');
  // Back to the current version.
  await click(`[...document.querySelectorAll('.menu .mi')].find((b) => b.textContent.startsWith('v30 · '))`);
});

await check('#36 in a short window, the composer’s + menu (above its button) and ⋯ (below) open whole, inside it', async () => {
  await page.size(1280, 420);
  await settle();
  for (const [what, sel] of [
    ['the + menu', `document.querySelector('button[aria-label="Add a file or a new agent"]')`],
    ['the ⋯ menu', `document.querySelector('header.topbar button[aria-label^="Actions for"]')`],
  ]) {
    await click(sel);
    const m = await menuBox();
    fits(m, what);
    // Short menus keep their height: nothing in them is squeezed.
    const squeezed = await page.evaluate(`[...document.querySelectorAll('.menu .mi')].some((b) => b.scrollHeight > b.clientHeight + 1)`);
    assert.equal(squeezed, false, `an item in ${what} is squeezed`);
    await pressEscape();
  }
  await page.size(1280, 1000);
});

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
if (page.logs.length) console.log(`\nPage errors:\n  ${page.logs.join('\n  ')}`);
finish();
