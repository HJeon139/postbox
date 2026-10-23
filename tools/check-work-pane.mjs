// A headless Chrome check of the right pane (#132, reworked from #138’s tabs): a conversation’s Work and a thread
// open beside it alone or together, split by a divider that moves by keyboard and mouse; Work expands to the whole
// window and closes with Escape or Close, with focus back where it was; a reply’s work line opens the pane at its
// turn; a reload restores what was open; and nothing scrolls sideways. Every case runs at 1280 and at 375 px.
//
//   node tools/check-work-pane.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory, has the
// mock @researcher do the demo’s two turns of work in “Citation fixes”, and drives the page with real key presses
// and clicks. PB_PORT and PB_CHROME_PORT move it, so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch } from './cdp.mjs';

const PORT = Number(process.env.PB_PORT ?? 4870);
const CHROME_PORT = Number(process.env.PB_CHROME_PORT ?? 10070);

process.env.POSTBOX_BACKENDS = 'mock';
process.env.POSTBOX_MOCK_SPEED = '0.1';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-work-pane-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;
const failures = [];

// ── Real input ──────────────────────────────────────────────────────────────────────────

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  Home: { code: 'Home', keyCode: 36 },
};
async function press(key, { shift = false, quick = false } = {}) {
  const k = KEYS[key];
  const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: shift ? 8 : 0 };
  await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  if (!quick) await settle();
}
const centerOf = (expr) =>
  page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
async function click(expr) {
  const r = await centerOf(expr);
  assert.ok(r, `Nothing to click: ${expr}`);
  // What’s under the pointer must be the element itself (or inside it), not something covering it.
  assert.ok(
    await page.evaluate(
      `(() => { const el = ${expr}; const at = document.elementFromPoint(${r.x}, ${r.y}); return !!at && (at === el || el.contains(at)); })()`,
    ),
    `Something covers ${expr}: ${await page.evaluate(`(() => { const at = document.elementFromPoint(${r.x}, ${r.y}); return at ? at.outerHTML.slice(0, 160) : 'nothing (off screen at ' + ${Math.round(r.x)} + ', ' + ${Math.round(r.y)} + ')'; })()`)}`,
  );
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const has = (sel) => page.evaluate(`!!${q(sel)}`);
const inside = (sel) => page.evaluate(`!!document.activeElement && !!document.activeElement.closest(${JSON.stringify(sel)})`);
const focusedId = () => page.evaluate('document.activeElement?.id ?? ""');
const hash = () => page.evaluate('location.hash');

async function check(name, fn) {
  let timer;
  try {
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 60 s')), 60000);
    });
    await Promise.race([fn(), late]);
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`);
  } finally {
    clearTimeout(timer);
  }
}
async function open(hashTo) {
  await page.evaluate(`location.hash = ${JSON.stringify(hashTo)}`);
  await page.waitFor(`document.querySelector('header.topbar')`);
  await settle();
}

/** Tabs from the conversation’s composer until focus lands in what sel finds; how many presses it took, or 0. */
async function tabTo(sel, max = 80) {
  await page.evaluate(`document.querySelector('.composer textarea').focus()`);
  for (let i = 1; i <= max; i++) {
    await press('Tab', { quick: true });
    if (await inside(sel)) return i;
  }
  return 0;
}

/** Nothing scrolls sideways: not the page, not the pane, not the expanded view. */
async function noSideways(where) {
  const over = await page.evaluate(`(() => {
    const out = [];
    const d = document.documentElement;
    if (d.scrollWidth > innerWidth + 1) out.push('the page by ' + (d.scrollWidth - innerWidth) + ' px');
    for (const sel of ['.wp-body', '.sp-body', '.dialog.full .d-body', '.rpane']) {
      const el = document.querySelector(sel);
      if (el && el.scrollWidth > el.clientWidth + 1) out.push(sel + ' by ' + (el.scrollWidth - el.clientWidth) + ' px');
    }
    return out;
  })()`);
  assert.deepEqual(over, [], `Scrolls sideways ${where}: ${over.join(', ')}`);
}

// ── The conversation, with two turns of work and a topic thread ─────────────────────────

const conv = Object.values(store.state.threads).find((t) => t.title === 'Citation fixes');
const other = Object.values(store.state.threads).find((t) => t.title === 'Agent memory papers');
const turnsDone = () => (store.state.work?.[conv.id] ?? []).filter((e) => e.kind === 'turn' && e.status !== 'running').length;
const waitUntil = async (fn, label, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
rt.sendMessage(conv.id, { text: 'Fix the citation script' });
await waitUntil(() => turnsDone() >= 1, 'the first turn’s work');
rt.sendMessage(conv.id, { text: 'Try a faster parser' });
await waitUntil(() => turnsDone() >= 2, 'the second turn’s work');
const turns = store.state.work[conv.id].filter((e) => e.kind === 'turn');
const root = store.items(conv.id).find((i) => i.kind === 'agent');
const { threadId: topic } = rt.startTopic(conv.id, root.id);
rt.addItem(topic, { kind: 'user', text: 'A question on the side.' });

const pane = (r) => `#/t/${conv.id}${r}`;
const WORK = 'aside.workpane';
const THREAD = 'aside.sidepanel';

await page.goto(`${app.origin}/#/t/${conv.id}`);
await page.waitFor(`document.querySelector('header.topbar #work-button')`, { label: 'the Work button' });

for (const [width, height] of [
  [1280, 900],
  [375, 812],
]) {
  const at = `${width} px`;
  await page.size(width, height);
  // Each width starts with nothing open, and the divider in the middle.
  await page.evaluate(
    `(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pb-work-') || k === 'pb-pane-split') localStorage.removeItem(k); })()`,
  );
  await open(pane(''));
  await page.evaluate('location.reload()');
  await page.waitFor(`document.querySelector('header.topbar #work-button')`, { label: 'the reloaded page' });
  await settle();

  await check(`${at}: the top bar’s Work button opens Work alone in the pane, and it reaches the keyboard`, async () => {
    assert.equal(await page.evaluate(`${q('#work-button')}.getAttribute('aria-pressed')`), 'false');
    // An icon with a name that says it, and a pressed state while it’s open.
    assert.equal(await page.evaluate(`${q('#work-button')}.getAttribute('aria-label')`), 'Work');
    await click(q('#work-button'));
    await page.waitFor(q(WORK), { label: 'the Work pane' });
    assert.equal(await hash(), pane('?work'));
    assert.equal(await has(THREAD), false, 'a thread opened too');
    assert.equal(await has('.rpane.split'), false);
    assert.equal(await page.evaluate(`${q('#work-button')}.getAttribute('aria-pressed')`), 'true');
    // Compact: the summary and stats, each a short list into its detail.
    for (const h of ['To review', 'Files', 'Commands', 'Outside Postbox', 'Spend', 'Turns'])
      assert.ok(await page.evaluate(`[...document.querySelectorAll('.wp-body h2')].some((x) => x.textContent.startsWith(${JSON.stringify(h)}))`), `no “${h}”`);
    // Both turns ran five commands, and two failed.
    assert.match(await page.evaluate(`document.querySelector('#wc-commands-h').parentElement.textContent`), /5 commands · 2 failed/);
    assert.ok((await tabTo(WORK)) > 0, 'Tab never reached the Work pane');
    await noSideways('with Work open');
  });

  await check(`${at}: Close shuts Work, focus goes back to the Work button, and a thread opens alone`, async () => {
    await click(q('#work-close'));
    await page.waitFor(`!${q(WORK)}`, { label: 'Work to close' });
    assert.equal(await hash(), pane(''));
    if (width >= 768) assert.equal(await focusedId(), 'work-button');
    await open(pane(`/side/${topic}`));
    await page.waitFor(q(THREAD), { label: 'the thread' });
    assert.equal(await has(WORK), false, 'Work opened with the thread');
    assert.ok((await tabTo(THREAD)) > 0, 'Tab never reached the thread');
    await noSideways('with a thread open');
  });

  await check(`${at}: Work opens beside the open thread, split above it, with a divider that moves by keyboard and mouse`, async () => {
    await click(q('#work-button'));
    await page.waitFor(`${q('.rpane.split')} && ${q(WORK)} && ${q(THREAD)}`, { label: 'the split pane' });
    assert.equal(await hash(), pane(`/side/${topic}?work`));
    const box = (sel) => page.evaluate(`(() => { const b = ${q(sel)}.getBoundingClientRect(); return { top: b.top, height: b.height, bottom: b.bottom }; })()`);
    const w = await box(WORK);
    const t = await box(THREAD);
    assert.ok(w.bottom <= t.top + 1, 'Work isn’t above the thread');
    assert.ok(w.height > 120 && t.height > 120, `too short: Work ${w.height} px, thread ${t.height} px`);
    // Both reach the keyboard, and so does the divider between them.
    assert.ok((await tabTo(WORK)) > 0, 'Tab never reached Work');
    assert.ok((await tabTo('.rp-divider')) > 0, 'Tab never reached the divider');
    assert.ok((await tabTo(THREAD)) > 0, 'Tab never reached the thread');
    // The keyboard moves the divider.
    await page.evaluate(`${q('.rp-divider')}.focus()`);
    const before = Number(await page.evaluate(`${q('.rp-divider')}.getAttribute('aria-valuenow')`));
    await press('ArrowDown');
    await press('ArrowDown');
    const after = Number(await page.evaluate(`${q('.rp-divider')}.getAttribute('aria-valuenow')`));
    assert.equal(after, before + 10);
    assert.ok((await box(WORK)).height > w.height + 20, 'Work didn’t grow');
    await press('Home');
    assert.equal(await page.evaluate(`${q('.rp-divider')}.getAttribute('aria-valuenow')`), '20');
    // So does the mouse.
    const d = await centerOf(q('.rp-divider'));
    const pr = await box('.rpane');
    const toY = Math.round(pr.top + pr.height * 0.6);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: d.x, y: d.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: d.x, y: d.y, button: 'left', clickCount: 1 });
    for (const y of [d.y + 40, toY]) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: d.x, y, button: 'left', buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: d.x, y: toY, button: 'left', clickCount: 1 });
    await settle();
    const dragged = Number(await page.evaluate(`${q('.rp-divider')}.getAttribute('aria-valuenow')`));
    assert.ok(Math.abs(dragged - 60) <= 3, `dragged to ${dragged}, not about 60`);
    await noSideways('with both open');
  });

  await check(`${at}: Expand shows the whole Work view over the window; Escape and Close bring it back, with focus on Expand`, async () => {
    await click(q('#work-expand'));
    await page.waitFor(`${q('.dialog.full .work-view')}`, { label: 'the expanded view' });
    assert.match(await hash(), /[?&]full\b/);
    assert.ok(await inside('.dialog.full'), 'focus didn’t move into the expanded view');
    const r = await page.evaluate(`(() => { const b = ${q('.dialog.full')}.getBoundingClientRect(); return { w: b.width, h: b.height }; })()`);
    assert.ok(r.w >= width - 16 && r.w <= width && r.h >= height - 16 && r.h <= height, `not the window: ${Math.round(r.w)} × ${Math.round(r.h)}`);
    // Everything #138’s page showed.
    for (const id of ['work-files', 'work-vcs', 'work-external', 'work-commands', 'work-effort']) assert.ok(await has(`.dialog.full #${id}`), `no #${id}`);
    await noSideways('expanded');
    await press('Escape');
    await page.waitFor(`!${q('.backdrop')}`, { label: 'the expanded view to close' });
    assert.equal(await focusedId(), 'work-expand');
    assert.doesNotMatch(await hash(), /full/);
    assert.ok(await has(WORK), 'the pane closed too');
    // The visible Close button does the same.
    await click(q('#work-expand'));
    await page.waitFor(q('.dialog.full'), { label: 'the expanded view again' });
    await click(`document.querySelector('.dialog.full .d-head button[aria-label="Close"]')`);
    await page.waitFor(`!${q('.backdrop')}`, { label: 'Close to close it' });
    assert.equal(await focusedId(), 'work-expand');
  });

  await check(`${at}: an item in the pane opens expanded at that item, and focus comes back to it`, async () => {
    const file = store.state.work[conv.id].find((e) => e.kind === 'file' && e.rel?.endsWith('refs.bib'));
    const row = `document.getElementById('wc-file-${file.id}') ?? document.getElementById('wc-review-${file.id}')`;
    await page.evaluate(`(${row}).focus()`);
    const id = await focusedId();
    await press('Enter');
    await page.waitFor(`document.querySelector('.dialog.full details[open] > summary#wsum-${file.id}')`, { label: 'refs.bib, opened' });
    assert.equal(await focusedId(), `wsum-${file.id}`);
    await page.waitFor(`document.querySelector('.dialog.full .work-diff')`, { label: 'its diff' });
    await press('Escape');
    await page.waitFor(`!${q('.backdrop')}`, { label: 'the expanded view to close' });
    assert.equal(await focusedId(), id);
  });

  await check(`${at}: a reply’s work line opens Work at its turn, beside the thread`, async () => {
    await click(q('#work-close'));
    await page.waitFor(`!${q(WORK)}`, { label: 'Work to close' });
    const second = turns[1];
    const chip = `[...document.querySelectorAll('.transcript .work-chip')].find((a) => a.getAttribute('href').includes('turn=${second.id}'))`;
    await page.waitFor(chip, { label: 'the second reply’s work line' });
    // At 375 the thread covers the conversation: close it to reach the line, as a person would.
    if (width < 768) {
      await click(`document.querySelector('${THREAD} .sp-head button[aria-label="Close thread"]')`);
      await page.waitFor(`!${q(THREAD)}`);
    }
    await click(chip);
    await page.waitFor(`document.querySelector('#wturn-${second.id}[open].is-target')`, { label: 'the turn, opened' });
    assert.equal(await hash(), width < 768 ? pane(`?work&turn=${second.id}`) : pane(`/side/${topic}?work&turn=${second.id}`));
    assert.equal(await page.evaluate(`document.activeElement === document.querySelector('#wturn-${second.id} > summary')`), true, 'focus isn’t on the turn');
    const seen = await page.evaluate(
      `(() => { const b = document.querySelector('.wp-body').getBoundingClientRect(); const t = document.querySelector('#wturn-${second.id}').getBoundingClientRect(); return t.top >= b.top - 1 && t.top < b.bottom - 20; })()`,
    );
    assert.ok(seen, 'the turn isn’t scrolled into view');
    assert.match(await page.evaluate(`document.querySelector('#wturn-${second.id}').textContent`), /1 command \(1 failed\)/);
    // Its own lines go on to that turn alone, expanded.
    await click(`document.getElementById('wc-open-${second.id}')`);
    await page.waitFor(`document.querySelector('.dialog.full .work-turn')`, { label: 'one turn, expanded' });
    await press('Escape');
    await page.waitFor(`!${q('.backdrop')}`);
    await noSideways('at a turn');
  });

  await check(`${at}: a reload restores what was open, and the conversation keeps Work open until it’s closed`, async () => {
    if (width < 768) await open(pane(`/side/${topic}?work`));
    await page.evaluate(`${q('.rp-divider')}.focus()`);
    await press('Home');
    await press('ArrowDown');
    await page.evaluate('location.reload()');
    await page.waitFor(`${q('.rpane.split')} && ${q(WORK)} && ${q(THREAD)}`, { label: 'both, after the reload' });
    assert.equal(await page.evaluate(`${q('.rp-divider')}.getAttribute('aria-valuenow')`), '25');
    // Expanded, too.
    await click(q('#work-expand'));
    await page.waitFor(q('.dialog.full'));
    await page.evaluate('location.reload()');
    await page.waitFor(`${q('.dialog.full .work-view')} && ${q(WORK)} && ${q(THREAD)}`, { label: 'expanded, after the reload' });
    await press('Escape');
    await page.waitFor(`!${q('.backdrop')}`);
    assert.equal(await focusedId(), 'work-expand');
    // Another conversation has nothing open; coming back, Work is open again, and so for a plain link to it.
    await open(`#/t/${other.id}`);
    assert.equal(await has('.rpane:not([hidden])'), false);
    await open(pane(''));
    await page.waitFor(q(WORK), { label: 'Work again' });
    assert.equal(await hash(), pane('?work'));
  });

  await check(`${at}: #138’s Work page links open the pane`, async () => {
    await open(pane('/work'));
    await page.waitFor(`location.hash === ${JSON.stringify(pane('?work'))}`, { label: 'the redirect' });
    await open(pane(`/work/${turns[0].id}`));
    await page.waitFor(`location.hash === ${JSON.stringify(pane(`?work&turn=${turns[0].id}`))} && document.querySelector('#wturn-${turns[0].id}[open]')`, {
      label: 'the turn’s redirect',
    });
    assert.equal(await has('nav.conv-tabs'), false, 'the tabs are back');
    await noSideways('after the redirect');
  });
}

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
if (page.logs.length) console.log(`\nPage errors:\n  ${page.logs.join('\n  ')}`);
console.log(failures.length ? `\n${failures.length} failed.` : '\nAll work pane checks passed.');
process.exit(failures.length ? 1 : 0);
