// What the right pane’s headless checks share (check-pane-width.mjs, check-pane-handle.mjs): a server of their own
// with the demo seed (mock agents) on a fresh data folder, a conversation with replies, an app and a topic thread,
// real input, and the layout as a person sees it. PB_PORT and PB_CHROME_PORT move it.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

/** The conversation column’s minimum, and its composer’s text box at that width (architecture.md §14). */
export const COL_MIN = 640;
export const BOX_MIN = 430;
export const WORK = 'aside.workpane';
export const THREAD = 'aside.sidepanel';

/** @type {any} */
export let page = null;
/** @type {any} */
let app = null;
let dataDir = '';
/** The conversation, its topic thread, and another conversation, by id. */
export const ids = { conv: '', topic: '', other: '' };
export const conv = (r) => `#/t/${ids.conv}${r}`;

/** Starts the server and the page, on the conversation. */
export async function begin(name, port, chromePort) {
  const { PORT, CHROME_PORT } = await ports(port, chromePort);
  process.env.POSTBOX_BACKENDS = 'mock';
  dataDir = await mkdtemp(join(tmpdir(), `pb-${name}-`));
  app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
  page = await launch({ port: CHROME_PORT });
  const { rt, store } = app;
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
  ids.conv = c.id;
  ids.topic = rt.startTopic(c.id, root.id).threadId;
  ids.other = Object.values(store.state.threads).find((t) => t.title === 'Agent memory papers').id;
  await page.goto(`${app.origin}/${conv('')}`);
  await page.waitFor(q('header.topbar #work-button'), { label: 'the Work button' });
}

export async function end() {
  await page.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  record(!page.logs.length, 'the page logged no errors', page.logs.join('\n'));
  finish();
}

export const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
export const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
export const has = (sel) => page.evaluate(`!!${q(sel)}`);
export const hash = () => page.evaluate('location.hash');
export async function press(key, code, keyCode) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await settle();
}
export async function click(expr) {
  const r = await page.evaluate(`(() => { const b = ${expr}.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}

export async function check(name, fn) {
  let timer;
  const late = new Promise((_, fail) => (timer = setTimeout(() => fail(new Error('Timed out after 60 s')), 60000)));
  await Promise.race([fn(), late]).then(
    () => record(true, name),
    (e) => record(false, name, e.message),
  );
  clearTimeout(timer);
}
export async function open(to) {
  // What the check changed on the server must have reached the page first, or it shows what was there before.
  await page.synced(app.store.state.seq);
  await page.evaluate(`location.hash = ${JSON.stringify(to)}`);
  await page.waitFor(`document.querySelector('header.topbar')`);
  await settle();
}
/**
 * A window this wide, with the sidebar open (or hidden, as the person left it), nothing else kept from before, and
 * the conversation alone.
 */
export async function fresh(width, { height = 800, railHidden = false } = {}) {
  await page.size(width, height);
  await page.waitFor(`innerWidth === ${width}`, { label: `a ${width} px window` });
  await page.evaluate(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pb-')) localStorage.removeItem(k); })()`);
  if (railHidden) await page.evaluate(`localStorage.setItem('pb-rail', 'hidden')`);
  await open(conv(''));
  await page.reload();
  await page.waitFor(q('.composer textarea'), { label: 'the conversation' });
  await settle();
}

/** The layout as a person sees it: the column, a reply, the composer’s text box, the pane, and full screen. */
export const measure = () =>
  page.evaluate(`(() => {
    const w = (sel) => { const el = document.querySelector(sel); return el && el.getClientRects().length ? Math.round(el.getBoundingClientRect().width) : 0; };
    const reply = Math.max(0, ...[...document.querySelectorAll('.transcript .md')].map((el) => Math.round(el.getBoundingClientRect().width)));
    return { main: w('.main'), reply, box: w('.composer textarea'), pane: w('.rpane'), rail: w('.rail'),
      app: w('.transcript .appframe'), auto: !!document.querySelector('.app.rail-auto'),
      toggle: document.getElementById('rail-toggle')?.getAttribute('aria-label'), full: !!document.querySelector('.pane-full'), focusIn: !!document.activeElement?.closest('.pane-full') };
  })()`);
