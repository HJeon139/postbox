// A headless Chrome check of how the right pane shares the window with the conversation (#197, #7): at 800, 1024 and
// 1280 px with the sidebar open, opening Work or a thread leaves the conversation column and the composer’s text box
// at or above their minimums, or opens the view full screen, where Escape brings the conversation back; what’s open
// stays in the address, so a wider window puts the pane back beside the conversation; and the sidebar hides first
// while the pane needs its room, giving an app more width, and comes back when the pane closes.
//
//   node tools/check-pane-width.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory, and drives
// the page with real key presses and clicks. PB_PORT and PB_CHROME_PORT move it, so sessions working in parallel
// don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4950, 10250);

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-pane-width-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;

/** The conversation column’s minimum, and its composer’s text box at that width (architecture.md §14). */
const COL_MIN = 640;
const BOX_MIN = 430;

// ── Real input ──────────────────────────────────────────────────────────────────────────

const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const has = (sel) => page.evaluate(`!!${q(sel)}`);
const hash = () => page.evaluate('location.hash');
async function press(key, code, keyCode) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await settle();
}
async function click(expr) {
  const r = await page.evaluate(`(() => { const b = ${expr}.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}

async function check(name, fn) {
  let timer;
  try {
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 60 s')), 60000);
    });
    await Promise.race([fn(), late]);
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  } finally {
    clearTimeout(timer);
  }
}
async function open(to) {
  // What the check changed on the server must have reached the page first, or it shows what was there before.
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = ${JSON.stringify(to)}`);
  await page.waitFor(`document.querySelector('header.topbar')`);
  await settle();
}
/** A window this wide, with the sidebar open, nothing kept from before, and the conversation alone. */
async function fresh(width, height = 800) {
  await page.size(width, height);
  await page.waitFor(`innerWidth === ${width}`, { label: `a ${width} px window` });
  await page.evaluate(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pb-')) localStorage.removeItem(k); })()`);
  await open(conv(''));
  await page.reload();
  await page.waitFor(q('.composer textarea'), { label: 'the conversation' });
  await settle();
}

/** The layout as a person sees it: the column, a reply, the composer’s text box, the pane, and full screen. */
const measure = () =>
  page.evaluate(`(() => {
    const w = (sel) => { const el = document.querySelector(sel); return el && el.getClientRects().length ? Math.round(el.getBoundingClientRect().width) : 0; };
    const reply = Math.max(0, ...[...document.querySelectorAll('.transcript .md')].map((el) => Math.round(el.getBoundingClientRect().width)));
    return { main: w('.main'), reply, box: w('.composer textarea'), pane: w('.rpane'), rail: w('.rail'),
      app: w('.transcript .appframe'), auto: !!document.querySelector('.app.rail-auto'),
      toggle: document.getElementById('rail-toggle')?.getAttribute('aria-label'), full: !!document.querySelector('.pane-full'), focusIn: !!document.activeElement?.closest('.pane-full') };
  })()`);

// ── A conversation with replies and a topic thread ─────────────────────────────────────

const c = Object.values(store.state.threads).find((t) => t.title === 'Citation fixes');
const [se] = rt.sessionsIn(c.id);
const say = (text) => rt.addItem(c.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
for (let i = 1; i <= 4; i++) {
  rt.addItem(c.id, { kind: 'user', text: `Question ${i}: which citations does the script still miss?` });
  say(`Answer ${i}: ${'The parser drops entries whose year sits in a note field, so the list comes up short. '.repeat(3)}`);
}
rt.toolsFor(se.id).show_app({
  id: 'explorer',
  title: 'Explorer',
  fallback: 'Explorer: a box as wide as its frame.',
  code: '<div style="height:200px;border:1px solid">An explorer</div>',
});
const root = store.items(c.id).find((i) => i.kind === 'agent');
const { threadId: topic } = rt.startTopic(c.id, root.id);
const conv = (r) => `#/t/${c.id}${r}`;
const WORK = 'aside.workpane';
const THREAD = 'aside.sidepanel';

await page.goto(`${app.origin}/${conv('')}`);
await page.waitFor(q('header.topbar #work-button'), { label: 'the Work button' });

// ── #197: the column keeps its minimum, or the view opens full screen ──────────────────

for (const [view, how] of [
  ['Work', () => click(q('#work-button'))],
  ['the thread', () => open(conv(`/side/${topic}`))],
])
  for (const width of [800, 1024, 1280])
    await check(`#197 at ${width} px with the sidebar open, ${view} leaves the column and the text box usable, or opens full screen`, async () => {
      await fresh(width);
      const before = await measure();
      await how();
      await page.waitFor(view === 'Work' ? q(WORK) : q(THREAD), { label: view });
      await settle();
      const m = await measure();
      const kept = m.main >= COL_MIN && m.box >= BOX_MIN && m.pane >= 320;
      assert.ok(
        m.full || kept,
        `the column is ${m.main} px (a reply ${m.reply} px), the text box ${m.box} px, the pane ${m.pane} px, and nothing is full screen`,
      );
      if (!m.full) return;
      // Full screen, the view is the window and a dialog, and the address still says only what’s open.
      assert.ok(m.focusIn, 'focus isn’t in the full-screen view');
      assert.doesNotMatch(await hash(), /full=/);
      // Escape brings the conversation back.
      await press('Escape', 'Escape', 27);
      await page.waitFor(`!${q('.pane-full')} && ${q('.rpane[hidden]')}`, { label: 'the conversation, with the pane closed' });
      assert.equal(await hash(), conv(''));
      const back = await measure();
      assert.deepEqual([back.main, back.box], [before.main, before.box], 'the conversation didn’t come back as it was');
    });

await check('#197 a wider window puts the pane back beside the conversation, since what’s open stays in the address', async () => {
  await fresh(800);
  await click(q('#work-button'));
  await page.waitFor(q('.workpane.pane-full'), { label: 'Work full screen at 800 px' });
  assert.equal(await hash(), conv('?work'));
  await page.size(1440, 800);
  await page.waitFor(`!${q('.pane-full')} && ${q(WORK)}`, { label: 'Work beside the conversation at 1440 px' });
  const m = await measure();
  assert.ok(m.main >= COL_MIN && m.pane >= 320, `the column is ${m.main} px and the pane ${m.pane} px`);
  // And narrower again, full screen again.
  await page.size(800, 800);
  await page.waitFor(q('.workpane.pane-full'), { label: 'Work full screen again at 800 px' });
  assert.equal(await has(`${WORK}:not(.pane-full)`), false);
});

// ── #7: the sidebar hides first, while the pane needs its room ─────────────────────────

await check('#7 at 1280 px, a thread hides the sidebar while it’s open, so an app keeps its room, and closing it brings the sidebar back', async () => {
  await fresh(1280);
  await page.waitFor(q('.transcript .appframe iframe'), { label: 'the app' });
  const before = await measure();
  assert.equal(before.rail, 248);
  await open(conv(`/side/${topic}`));
  await page.waitFor(q(THREAD), { label: 'the thread' });
  const m = await measure();
  assert.deepEqual([m.rail, m.auto, m.pane, m.toggle], [0, true, 440, 'Show the sidebar'], 'the sidebar didn’t hide for the pane');
  // #7 measured an app at about 590 px beside the pane with the sidebar open.
  assert.ok(m.app > 700, `the app is ${m.app} px`);
  await click(`${q(THREAD)}.querySelector('button[aria-label="Close thread"]')`);
  await page.waitFor(q('.rpane[hidden]'), { label: 'the thread to close' });
  const back = await measure();
  assert.deepEqual([back.rail, back.auto, back.toggle, back.app], [248, false, 'Hide the sidebar', before.app], 'the sidebar didn’t come back');
  assert.equal(await page.evaluate(`localStorage.getItem('pb-rail')`), null, 'it changed what the person chose');
});

await check('#7 showing the sidebar again while the pane is open keeps it, and the pane makes do with what’s left', async () => {
  await fresh(1280);
  await click(q('#work-button'));
  await page.waitFor(`${q(WORK)} && ${q('.app.rail-auto')}`, { label: 'Work, with the sidebar hidden' });
  await click(q('#rail-toggle'));
  await page.waitFor(`!${q('.app.rail-auto')}`, { label: 'the sidebar back' });
  const m = await measure();
  assert.deepEqual([m.rail, m.toggle, m.full], [248, 'Hide the sidebar', false]);
  assert.ok(m.main >= COL_MIN && m.pane === 1280 - 248 - COL_MIN, `the column is ${m.main} px and the pane ${m.pane} px`);
});

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
record(!page.logs.length, 'the page logged no errors', page.logs.join('\n'));
finish();
