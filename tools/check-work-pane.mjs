// A headless Chrome check of the right pane (#132, reworked from #138’s tabs): a conversation’s Work and a thread
// open beside it alone or together, split by a divider that moves by keyboard and mouse; either goes full screen
// with the app frames’ icon and comes back with Escape or the icon, with focus on it; a thread does so in place,
// keeping its draft, its scroll and a streaming reply; a reply’s work line opens the pane at its turn; a reload
// restores what was open; and nothing scrolls sideways. Every case runs at 1280 and at 375 px.
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
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4870, 10070);

process.env.POSTBOX_BACKENDS = 'mock';
process.env.POSTBOX_MOCK_SPEED = '0.1';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-work-pane-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;

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
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
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
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  } finally {
    clearTimeout(timer);
  }
}
async function open(hashTo) {
  // What the check changed on the server must have reached the page first, or it shows what was there before.
  await page.synced(store.state.seq);
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
    for (const sel of ['.wp-body', '.sp-body', '.rpane', '.pane-full']) {
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
// Long enough to scroll, in the pane and full screen.
for (let i = 0; i < 24; i++)
  rt.addItem(topic, { kind: 'user', text: `Side question ${i + 1}: ${'a longer line that wraps across the panel and reads at the column width, '.repeat(3)}` });

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
  await page.reload();
  await page.waitFor(`document.querySelector('header.topbar #work-button')`, { label: 'the reloaded page' });
  await settle();

  await check(`${at}: the top bar’s Work button says Work (#183), opens Work alone in the pane, and it reaches the keyboard`, async () => {
    assert.equal(await page.evaluate(`${q('#work-button')}.getAttribute('aria-pressed')`), 'false');
    // It says Work in words beside its icon (#183); on a phone only the icon shows, square, and Work is still its
    // name. It shows pressed while Work is open.
    const btn = await page.evaluate(
      `(() => { const b = ${q('#work-button')}; const w = b.querySelector('.sr-sm'); return { name: b.textContent.trim(), label: b.getAttribute('aria-label'), icon: !!b.querySelector('.i-file'), word: w.getBoundingClientRect().width, width: b.getBoundingClientRect().width }; })()`,
    );
    assert.deepEqual([btn.name, btn.label, btn.icon], ['Work', null, true]);
    if (width >= 768) assert.ok(btn.word > 20, `“Work” is ${btn.word} px wide, so it doesn’t show`);
    else assert.deepEqual([btn.word <= 1, btn.width], [true, 26], `“Work” is ${btn.word} px wide on a phone, in a ${btn.width} px button`);
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

  await check(`${at}: Work goes full screen with the app frames’ icon; Escape and the icon bring it back, with focus on the icon`, async () => {
    assert.equal(await page.evaluate(`${q('#work-full')}.getAttribute('aria-label')`), 'Full screen');
    await click(q('#work-full'));
    await page.waitFor(q('.workpane.pane-full .work-view'), { label: 'Work full screen' });
    assert.match(await hash(), /[?&]full=work\b/);
    assert.ok(await inside('.workpane.pane-full'), 'focus didn’t move into it');
    assert.equal(await page.evaluate(`${q('#work-full')}.getAttribute('aria-label')`), 'Exit full screen');
    const r = await page.evaluate(`(() => { const b = ${q('.workpane.pane-full')}.getBoundingClientRect(); return { w: b.width, h: b.height }; })()`);
    assert.ok(r.w === width && r.h === height, `not the window: ${Math.round(r.w)} × ${Math.round(r.h)}`);
    // #138’s view, as it was.
    for (const id of ['work-files', 'work-vcs', 'work-external', 'work-commands', 'work-effort']) assert.ok(await has(`.pane-full #${id}`), `no #${id}`);
    // Tab stays in it.
    for (let i = 0; i < 30; i++) await press('Tab', { quick: true });
    assert.ok(await inside('.workpane.pane-full'), 'Tab left full screen');
    await noSideways('full screen');
    await press('Escape');
    await page.waitFor(`!${q('.pane-full')}`, { label: 'full screen to end' });
    assert.equal(await focusedId(), 'work-full');
    assert.doesNotMatch(await hash(), /full/);
    assert.ok(await has('.wp-body .wc-sec'), 'the compact form didn’t come back');
    // The icon, now “Exit full screen”, does the same.
    await click(q('#work-full'));
    await page.waitFor(q('.workpane.pane-full'), { label: 'full screen again' });
    await click(q('#work-full'));
    await page.waitFor(`!${q('.pane-full')}`, { label: 'the icon to end it' });
    assert.equal(await focusedId(), 'work-full');
  });

  await check(`${at}: an item in the pane opens full screen at that item`, async () => {
    const file = store.state.work[conv.id].find((e) => e.kind === 'file' && e.rel?.endsWith('refs.bib'));
    const row = `document.getElementById('wc-file-${file.id}') ?? document.getElementById('wc-review-${file.id}')`;
    await page.evaluate(`(${row}).focus()`);
    const id = await focusedId();
    await press('Enter');
    await page.waitFor(`document.querySelector('.pane-full details[open] > summary#wsum-${file.id}')`, { label: 'refs.bib, opened' });
    assert.equal(await focusedId(), `wsum-${file.id}`);
    await page.waitFor(`document.querySelector('.pane-full .work-diff')`, { label: 'its diff' });
    await press('Escape');
    await page.waitFor(`!${q('.pane-full')}`, { label: 'full screen to end' });
    // Back to the item you chose.
    assert.equal(await focusedId(), id);
  });

  await check(`${at}: the thread goes full screen in place, keeping its draft, its scroll and a streaming reply`, async () => {
    const body = q(`${THREAD} .sp-body`);
    const ta = q(`${THREAD} .composer textarea`);
    await page.evaluate(`window.__ta = ${ta}; window.__body = ${body}; window.__panel = ${q(THREAD)};`);
    await page.evaluate(`(() => { const t = ${ta}; t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); })()`);
    await page.send('Input.insertText', { text: 'A draft reply' });
    // Scrolled up to the middle, by the wheel, as a person scrolls, so there’s more than a window’s worth below it.
    const b = await centerOf(body);
    for (let i = 0; i < 8; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: b.x, y: b.y, deltaX: 0, deltaY: -300 });
    await settle();
    const reading = () =>
      page.evaluate(`(() => {
        const box = ${body}.getBoundingClientRect();
        // What the transcript holds in place when its size changes: the message across the middle of the view (#162).
        const mid = box.top + ${body}.clientHeight / 2;
        const items = [...${body}.querySelectorAll('.transcript > [data-key]')].filter((n) => n.getBoundingClientRect().bottom > box.top);
        const it = items.find((n) => n.getBoundingClientRect().bottom > mid) ?? items.at(-1);
        return { key: it.dataset.key, top: Math.round(it.getBoundingClientRect().top - box.top) };
      })()`);
    const before = await reading();
    await click(q('#thread-full'));
    await page.waitFor(q('.sidepanel.pane-full'), { label: 'the thread full screen' });
    assert.match(await hash(), /[?&]full=thread\b/);
    assert.equal(await focusedId(), 'thread-full');
    assert.equal(await page.evaluate(`${q('#thread-full')}.getAttribute('aria-label')`), 'Exit full screen');
    // The same nodes, not a copy: nothing was rebuilt.
    assert.equal(await page.evaluate(`window.__ta === ${ta} && window.__body === ${body} && window.__panel === ${q(THREAD)}`), true, 'the thread was rebuilt');
    assert.equal(await page.evaluate(`${ta}.value`), 'A draft reply');
    const r = await page.evaluate(`(() => { const b = ${q('.sidepanel.pane-full')}.getBoundingClientRect(); return { w: b.width, h: b.height }; })()`);
    assert.ok(r.w === width && r.h === height, `not the window: ${Math.round(r.w)} × ${Math.round(r.h)}`);
    // At the message column’s width.
    const col = await page.evaluate(`Math.round(${q('.sidepanel.pane-full .sp-body .transcript')}.getBoundingClientRect().width)`);
    assert.ok(col <= 760 && col >= Math.min(760, width - 48), `the column is ${col} px`);
    // The message you were reading starts where it did, though the wider column makes it shorter.
    const topNow = (key = before.key) =>
      page.evaluate(`Math.round(document.querySelector('[data-key="${key}"]').getBoundingClientRect().top - ${body}.getBoundingClientRect().top)`);
    const inFull = await topNow();
    assert.ok(Math.abs(inFull - before.top) <= 3, `the message you were reading moved from ${before.top} to ${inFull} px`);
    await noSideways('with the thread full screen');
    // A reply streams in while it’s full screen, into the same transcript.
    const n = store.items(topic).length;
    rt.sendMessage(topic, { text: 'One more thing on the side' });
    await waitUntil(
      () =>
        store
          .items(topic)
          .slice(n)
          .some((i) => i.kind === 'agent'),
      'the reply to start',
    );
    const reply = store
      .items(topic)
      .slice(n)
      .find((i) => i.kind === 'agent');
    await page.waitFor(`document.querySelector('.sidepanel.pane-full [data-key="${reply.id}"]')`, { label: 'the reply, full screen' });
    await waitUntil(() => store.items(topic).find((i) => i.id === reply.id)?.status === 'done', 'the reply to finish');
    const final = store
      .items(topic)
      .find((i) => i.id === reply.id)
      .text.slice(-12);
    await page.waitFor(`document.querySelector('.sidepanel.pane-full [data-key="${reply.id}"]')?.textContent.includes(${JSON.stringify(final)})`, {
      label: 'the reply to finish, full screen',
    });
    // Escape brings it back to the pane, with focus on the icon, the draft and the transcript as they were: the first
    // message in view stays where it starts.
    const last = await reading();
    await press('Escape');
    await page.waitFor(`!${q('.pane-full')}`, { label: 'full screen to end' });
    assert.equal(await focusedId(), 'thread-full');
    assert.equal(await page.evaluate(`window.__ta === ${ta} && ${ta}.value`), 'A draft reply');
    const back = await topNow(last.key);
    assert.ok(Math.abs(back - last.top) <= 3, `back in the pane, the message you were reading moved from ${last.top} to ${back} px`);
    assert.ok(await has(`.sidepanel [data-key="${reply.id}"]`), 'the reply went');
    // The icon brings it back too.
    await click(q('#thread-full'));
    await page.waitFor(q('.sidepanel.pane-full'));
    await click(q('#thread-full'));
    await page.waitFor(`!${q('.pane-full')}`, { label: 'the icon to end it' });
    assert.equal(await focusedId(), 'thread-full');
    // A reload restores it.
    await click(q('#thread-full'));
    await page.waitFor(q('.sidepanel.pane-full'));
    await page.reload();
    await page.waitFor(`${q('.sidepanel.pane-full .sp-body .transcript [data-key]')}`, { label: 'the thread full screen, after the reload' });
    await press('Escape');
    await page.waitFor(`!${q('.pane-full')}`);
    assert.equal(await focusedId(), 'thread-full');
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
    await page.waitFor(`document.querySelector('.pane-full .work-turn')`, { label: 'one turn, full screen' });
    await press('Escape');
    await page.waitFor(`!${q('.pane-full')}`);
    await noSideways('at a turn');
  });

  await check(`${at}: a reload restores what was open, and the conversation keeps Work open until it’s closed`, async () => {
    if (width < 768) await open(pane(`/side/${topic}?work`));
    await page.evaluate(`${q('.rp-divider')}.focus()`);
    await press('Home');
    await press('ArrowDown');
    await page.reload();
    await page.waitFor(`${q('.rpane.split')} && ${q(WORK)} && ${q(THREAD)}`, { label: 'both, after the reload' });
    assert.equal(await page.evaluate(`${q('.rp-divider')}.getAttribute('aria-valuenow')`), '25');
    // Full screen, too.
    await click(q('#work-full'));
    await page.waitFor(q('.workpane.pane-full'));
    await page.reload();
    await page.waitFor(`${q('.workpane.pane-full .work-view')} && ${q(THREAD)}`, { label: 'full screen, after the reload' });
    await press('Escape');
    await page.waitFor(`!${q('.pane-full')}`);
    assert.equal(await focusedId(), 'work-full');
    // Another conversation has nothing open; coming back, Work and the thread are open again (#122), and so for a
    // plain link to it. In a narrow window, where the pane would cover it, the conversation opens on its own.
    await open(`#/t/${other.id}`);
    assert.equal(await has('.rpane:not([hidden])'), false);
    await open(pane(''));
    if (width >= 768) {
      await page.waitFor(`${q(WORK)} && ${q(THREAD)}`, { label: 'Work and the thread again' });
      assert.equal(await hash(), pane(`/side/${topic}?work`));
    } else {
      assert.equal(await hash(), pane(''));
      assert.equal(await has('.rpane:not([hidden])'), false, 'the pane covers the conversation');
    }
  });

  await check(`${at}: #138’s Work page links open the pane`, async () => {
    await open(pane('/work'));
    await page.waitFor(`location.hash === ${JSON.stringify(pane('?work'))}`, { label: 'the redirect' });
    await open(pane(`/work/${turns[0].id}`));
    await page.waitFor(`location.hash === ${JSON.stringify(pane(`?work&turn=${turns[0].id}`))} && document.querySelector('#wturn-${turns[0].id}[open]')`, {
      label: 'the turn’s redirect',
    });
    assert.equal(await has('nav.conv-tabs'), false, 'the tabs are back');
    // Only a view that’s open goes full screen: with no thread, no thread full screen.
    await open(pane('?full=thread'));
    assert.equal(await has('.pane-full'), false, 'something went full screen');
    await noSideways('after the redirect');
  });
}

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
record(!page.logs.length, 'the page logged no errors', page.logs.join('\n'));
finish();
