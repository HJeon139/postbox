// A headless Chrome check of the shell, driven with real key presses and clicks: open blocks shown
// quietly instead of “needs you” (#69), the words for conversations (#4), and focus that stays on the
// control you used in a sheet and goes back to where you opened it (#26), and menus that close when you
// click their button again (#29).
//
//   node tools/check-shell.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory,
// and a second one as a fresh install for the first-run overview. PB_PORT (and the port after it) and
// PB_CHROME_PORT move them, so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4795, 9995, { span: 2 });

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-shell-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;

// ── Real input ──────────────────────────────────────────────────────────────────────────

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
};
/** Presses a key the way a keyboard does: keydown (with its text), then keyup. */
async function press(key, { shift = false } = {}) {
  const k = KEYS[key];
  const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: shift ? 8 : 0 };
  await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await settle();
}
/** Clicks the middle of the element an expression finds, with the mouse. */
async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  assert.ok(r, `Nothing to click: ${expr}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
// Headless Chrome can hold back animation frames while nothing on screen changes, so wait on a timer too.
const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
/** Puts focus on an element, as Tab would, before the key presses that test it. */
const focus = async (expr) => {
  assert.ok(await page.evaluate(`(() => { const el = ${expr}; el?.focus(); return !!el && document.activeElement === el; })()`), `Couldn’t focus: ${expr}`);
};
/** A short description of the focused element: its role or tag, and its name or text. */
const focused = () =>
  page.evaluate(
    `(() => { const a = document.activeElement; if (!a || a === document.body) return 'body'; return (a.getAttribute('role') ?? a.tagName.toLowerCase()) + ': ' + (a.getAttribute('aria-label') ?? a.textContent.trim().replace(/\\s+/g, ' ')).slice(0, 60); })()`,
  );
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((n) => n.textContent.includes(${JSON.stringify(text)}))`;
const threadNamed = (title) => Object.values(store.state.threads).find((t) => t.title === title);

async function check(name, fn) {
  let timer;
  try {
    // One case that hangs mustn’t block the rest.
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 30 s')), 30000);
    });
    await Promise.race([fn(), late]);
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  } finally {
    clearTimeout(timer);
  }
  // Each case starts from a clean page: Escape closes any menu or dialog left open, the way a person would,
  // so its listeners go with it.
  for (let i = 0; i < 4 && (await page.evaluate(`!!document.querySelector('.backdrop, .menu')`)); i++) await press('Escape');
}
let loaded = false;
/** Opens a view: the first time by loading the page, then by changing the hash, as the app’s links do. */
async function open(hash) {
  if (loaded) await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  else await page.goto(`${app.origin}/${hash}`);
  loaded = true;
  await page.waitFor(`document.querySelector('header.topbar')`);
  await settle();
}

await page.size(1280, 900);

// ── #69: an open block from an earlier turn is shown quietly ─────────────────────────────

await check('#69 an older open block shows “1 open confirmation”, not needs-you, and goes to the block', async () => {
  const t = threadNamed('Corpus planning');
  const se = rt.sessionsIn(t.id).find((x) => x.handle === 'indexer');
  // A block from a turn that has ended, left unanswered.
  rt.toolsFor(se.id, null).show_block({
    block: { id: 'old-ask', type: 'confirm', version: 1, fallback: 'x', statement: 'Rename them?', confirmLabel: 'Rename' },
  });
  await open(`#/t/${t.id}`);
  const label = `${q('header.topbar [data-open-asks]')}`;
  await page.waitFor(`${label} && !${label}.hidden`, { label: 'the top bar’s open-blocks button' });
  assert.equal(await page.evaluate(`${label}.textContent`), '1 open confirmation');
  assert.equal(store.state.sessions[se.id].needs, null);
  await click(label);
  assert.match(await focused(), /Rename/);
  await open('#/');
  const onCard = `document.querySelector('.ov-col[data-key="${se.id}"] [data-open-asks]')`;
  await page.waitFor(`${onCard}?.textContent === '1 open confirmation'`, { label: 'the card’s open-blocks line' });
  // Answering it clears the line.
  const block = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'old-ask');
  rt.act(t.id, block.id, 'confirm', {});
  await page.waitFor(`${onCard}?.hidden`, { label: 'the line to clear once answered' });
});

// ── #26: focus stays on the control you used, and goes back where it came from ──────────

const dialogOpen = `!!document.querySelector('.backdrop .dialog')`;

await check('#26 new agent: Space on a Tools checkbox keeps focus on it', async () => {
  await open('#/');
  await click(byText('main.ov button', 'New agent'));
  await page.waitFor(dialogOpen);
  const box = `document.querySelectorAll('.d-body [role=checkbox]')[1]`;
  const before = await page.evaluate(`${box}.getAttribute('aria-checked')`);
  const name = await page.evaluate(`${box}.textContent`);
  await focus(box);
  await press(' ');
  assert.equal(await focused(), `checkbox: ${name.replace(/\s+/g, ' ').trim()}`.slice(0, 70));
  assert.notEqual(await page.evaluate(`document.activeElement.getAttribute('aria-checked')`), before);
  await press(' ');
  assert.equal(await page.evaluate(`document.activeElement.getAttribute('aria-checked')`), before);
});

await check('#26 new room: Enter on the @indexer chip keeps focus on it', async () => {
  const t = threadNamed('Corpus planning');
  await open(`#/p/${t.projectId}`);
  await click(q('button[aria-label="New room"]'));
  await page.waitFor(dialogOpen);
  await focus(byText('.d-body .chips button', '@indexer'));
  await press('Enter');
  assert.equal(await focused(), 'button: @indexer');
  assert.equal(await page.evaluate(`document.activeElement.getAttribute('aria-pressed')`), 'true');
  await press('Enter');
  assert.equal(await focused(), 'button: @indexer');
  assert.equal(await page.evaluate(`document.activeElement.getAttribute('aria-pressed')`), 'false');
});

await check('#26 settings: Enter on the Projects tab keeps focus on it, and Escape returns to Settings', async () => {
  await open('#/');
  await focus(q('header.topbar button[aria-label="Settings"]'));
  await press('Enter');
  await page.waitFor(dialogOpen);
  await focus(byText('[role=tab]', 'Projects'));
  await press('Enter');
  assert.equal(await focused(), 'tab: Projects');
  assert.equal(await page.evaluate(`document.activeElement.getAttribute('aria-selected')`), 'true');
  await press('Escape');
  assert.equal(await focused(), 'button: Settings');
});

await check('#26 ⋯ › Add an agent… by keyboard, then Escape, returns focus to ⋯', async () => {
  const t = threadNamed('Corpus planning');
  await open(`#/t/${t.id}`);
  await focus(q('header.topbar button[aria-label^="Actions for"]'));
  await press('Enter');
  assert.equal(await focused(), 'menuitem: Rename…');
  await press('ArrowDown');
  assert.match(await focused(), /^menuitem: Add an agent…/);
  await press('Enter');
  await page.waitFor(dialogOpen);
  // #4: the sheet says “conversation”, never “thread”.
  const words = await page.evaluate(`document.querySelector('.dialog').textContent`);
  assert.match(words, /Join this conversation/);
  assert.match(words, /New conversation in Book corpus/);
  assert.doesNotMatch(words, /\bthread\b/i);
  await press('Escape');
  assert.equal(await focused(), 'button: Actions for Corpus planning');
});

await check('#26 the folder picker opens with focus on its first entry, and Escape returns to +', async () => {
  const t = threadNamed('Corpus planning');
  await open(`#/t/${t.id}`);
  await focus(q('button[aria-label="Add a file or a new agent"]'));
  await press('Enter');
  for (let i = 0; i < 5 && !/From the project folder/.test(await focused()); i++) await press('ArrowDown');
  assert.match(await focused(), /^menuitem: From the project folder/);
  await press('Enter');
  await page.waitFor(`document.activeElement?.closest('.d-body li')`, { label: 'focus on an entry' });
  assert.equal(
    await page.evaluate(`document.activeElement === document.querySelector('.d-body li button')`),
    true,
    `Focus is on ${await focused()}, not the first entry`,
  );
  await press('Escape');
  assert.equal(await focused(), 'button: Add a file or a new agent');
});

// ── #29: clicking a menu’s button again closes it ──────────────────────────────────────

const MENUS = [
  ['the Postbox mark', 'conversation', 'header.topbar button.brand'],
  ['the conversation’s ⋯', 'conversation', 'header.topbar button[aria-label^="Actions for"]'],
  ['the composer’s +', 'conversation', 'button[aria-label="Add a file or a new agent"]'],
  ['a session card’s ⋯', 'overview', 'main.ov button[aria-label^="Session actions for"]'],
];
for (const [name, view, sel] of MENUS)
  await check(`#29 a second click on ${name} closes its menu`, async () => {
    await open(view === 'overview' ? '#/' : `#/t/${threadNamed('Corpus planning').id}`);
    const state = () => page.evaluate(`[document.querySelectorAll('.menu').length, ${q(sel)}.getAttribute('aria-expanded')]`);
    await click(q(sel));
    assert.deepEqual(await state(), [1, 'true'], 'The first click opens it');
    await click(q(sel));
    assert.deepEqual(await state(), [0, 'false'], 'The second click closes it');
    await click(q(sel));
    assert.deepEqual(await state(), [1, 'true'], 'A third click opens it again');
  });

await check('#29 a second click closes a card’s menu even after the card repainted under it', async () => {
  await open('#/');
  const t = threadNamed('Corpus planning');
  const se = rt.sessionsIn(t.id).find((x) => x.handle === 'indexer');
  const sel = `document.querySelector('.ov-col[data-key="${se.id}"] button[aria-haspopup=menu]')`;
  await click(sel);
  await page.evaluate(`window.__first = ${sel}`);
  // A working agent’s card repaints as it goes, which rebuilds its ⋯ button.
  rt.updateSession(se.id, { currentStep: 'Reading the shelf' });
  await page.waitFor(`${sel} !== window.__first`, { label: 'the card to repaint' });
  await click(sel);
  assert.equal(await page.evaluate(`document.querySelectorAll('.menu').length`), 0);
});

await check('#26 ⋯ › Rename… by keyboard returns focus to ⋯ after the top bar repaints with the new name', async () => {
  const t = threadNamed('Index the shelf');
  await open(`#/t/${t.id}`);
  await focus(q('header.topbar button[aria-label^="Actions for"]'));
  await press('Enter');
  assert.equal(await focused(), 'menuitem: Rename…');
  await press('Enter');
  await page.waitFor(dialogOpen);
  await page.send('Input.insertText', { text: ' (2)' });
  await press('Enter');
  await page.waitFor(`!${dialogOpen} && document.querySelector('header.topbar button[aria-label="Actions for Index the shelf (2)"]')`, {
    label: 'the renamed top bar',
  });
  await settle();
  assert.equal(await focused(), 'button: Actions for Index the shelf (2)');
});

// ── A fresh install’s overview leads to a first project ─────────────────────────────────

await check('a fresh install’s empty overview offers New project, which opens Settings › Projects', async () => {
  const freshDir = await mkdtemp(join(tmpdir(), 'pb-check-shell-fresh-'));
  const fresh = await start({ port: PORT + 1, dataDir: freshDir, fresh: true, quiet: true });
  try {
    // A fresh install has no projects or conversations. Older seeds made some, so clear them to match.
    Object.assign(fresh.store.state, { projects: {}, threads: {}, sessions: {}, items: {} });
    // Not page.goto(): it waits for an animation frame, which headless Chrome can hold back by now.
    await page.send('Page.navigate', { url: `${fresh.origin}/#/` });
    await page.waitFor(`document.querySelector('.ov-empty')`, { label: 'the empty overview' });
    assert.match(await page.evaluate(`document.querySelector('.ov-empty').textContent`), /Create a project to start, or create an agent\./);
    await focus(byText('.ov-empty button', 'New project'));
    await press('Enter');
    await page.waitFor(dialogOpen);
    assert.equal(await page.evaluate(`document.querySelector('[role=tab][aria-selected=true]').textContent`), 'Projects');
    await press('Escape');
    assert.equal(await focused(), 'button: New project');
  } finally {
    // Leave the page first, so closing the server doesn’t cut its event stream mid-message.
    await page.send('Page.navigate', { url: 'about:blank' });
    await fresh.close();
    await rm(freshDir, { recursive: true, force: true });
  }
});

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
if (page.logs.length) console.log(`\nPage errors:\n  ${page.logs.join('\n  ')}`);
finish();
