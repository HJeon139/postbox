// A headless Chrome check that apps and asking blocks follow the conversation (#49, #92): a new version, or a block
// that asks again, shows at the newest point, in view without scrolling, with a one-line stub where it was that
// leads to it, one live copy, and the transcript’s anchoring intact: what you were reading stays put, and if you
// were reading the item, its stub holds its place. ⌃J reaches a block that moved.
//
//   node tools/checks/follow.mjs            (ONLY=#49 runs the cases whose name has that in it)
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory.
// PB_PORT and PB_CHROME_PORT move it (4620 and 9820 by default), so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { launch } from '../cdp.mjs';
import { finish, ports, record } from '../harness.mjs';

const { PORT, CHROME_PORT } = await ports(4620, 9820);

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-follow-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;

const settle = (ms = 250) => page.evaluate(`new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, ${ms}); })`);
async function wheel(deltaY) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 760, y: 400, deltaX: 0, deltaY });
  await settle();
}
async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  assert.ok(r, `Nothing to click: ${expr}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' });
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await settle();
}
const gap = () => page.evaluate('Math.round(document.scrollingElement.scrollHeight - scrollY - innerHeight)');
const reading = () =>
  page.evaluate(
    `(() => { const n = document.elementFromPoint(760, innerHeight / 2)?.closest('.item'); return n ? { key: n.dataset.key, top: Math.round(n.getBoundingClientRect().top) } : null; })()`,
  );
const topOf = (key) => page.evaluate(`Math.round(document.querySelector('[data-key="${key}"]')?.getBoundingClientRect().top ?? NaN)`);
/** Whether the whole of an item is inside the window, under the top bar and above the composer. */
const inView = (key) =>
  page.evaluate(
    `(() => { const n = document.querySelector('[data-key="${key}"]'); if (!n) return false; const b = n.getBoundingClientRect(); const c = document.querySelector('.composer')?.getBoundingClientRect().top ?? innerHeight; return b.top >= 0 && b.bottom <= c + 1; })()`,
  );
const lastKey = () => page.evaluate(`[...document.querySelectorAll('#main > .item')].at(-1)?.dataset.key`);

async function check(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
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
}

const persona = (handle) => Object.values(store.state.personas).find((p) => p.handle === handle);
const project = Object.values(store.state.projects)[0];
const LONG = (n) =>
  `Message ${n}. The ReAct loop alternates a thought, an action and an observation; the observation is the only outside evidence, so it keeps the plan grounded while the agent works through the search results one at a time.`;
/** A room with an app from critic, then `after` long messages under it. */
function room(title, appId, after = 14) {
  const t = rt.createThread({ projectId: project.id, title, personaIds: [persona('researcher').id, persona('critic').id] });
  const [researcher, critic] = rt.sessionsIn(t.id);
  const say = (se, text) => rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  for (let i = 1; i <= 4; i++) say(i % 2 ? critic : researcher, LONG(i));
  const tools = rt.toolsFor(critic.id);
  tools.show_app({ id: appId, title: 'Pair explorer', code: APP('v1'), permissions: [] });
  for (let i = 0; i < after; i++) say(i % 2 ? critic : researcher, LONG(100 + i));
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === appId);
  return { t, critic, tools, say, item };
}
const APP = (label) =>
  `<main style="padding:12px"><button class="btn" type="button" style="display:block;width:100%;height:200px">Explorer ${label}</button></main>`;
async function open(t) {
  // The page sends you to the overview while the new conversation hasn’t reached it yet, and shows only what has,
  // so wait until it has heard everything the server has.
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = '#/t/${t.id}'`);
  await page.waitFor(`!!document.querySelector('.transcript[data-thread="${t.id}"] .item')`, { label: 'the transcript' });
  await settle(400);
}
/** Waits for the stub of an item to be on the page, and returns its key. */
async function stubOf(t, itemId) {
  const stub = store.items(t.id).findLast((i) => i.kind === 'moved' && i.itemId === itemId);
  assert.ok(stub, 'the server made a stub');
  await page.waitFor(
    `document.querySelector('[data-key="${stub.id}"]') && [...document.querySelectorAll('#main > .item')].at(-1)?.dataset.key === '${itemId}'`,
    {
      label: 'the stub and the moved item on the page',
    },
  );
  await settle(400);
  return stub.id;
}

await page.size(1280, 900, { theme: 'light' });
await page.goto(`${app.origin}/#/`);

await check('#49 at the bottom: a new version shows at the newest point, in view, with a stub where it was and one copy', async () => {
  const { t, tools, item } = room('Follows at the bottom', 'follow-bottom');
  await open(t);
  assert.ok((await gap()) <= 2, 'opens at the bottom');
  assert.ok(!(await inView(item.id)), 'the app starts out of view, above');
  rt.addItem(t.id, { kind: 'user', text: 'The graph overlaps. Can you fix it?' });
  tools.update_app({ id: 'follow-bottom', code: APP('v2'), summary: 'each group laid out on its own' });
  const stub = await stubOf(t, item.id);
  assert.equal(await lastKey(), item.id, 'the app is the newest item');
  assert.ok((await gap()) <= 2, `the view stays at the bottom (gap ${await gap()})`);
  assert.ok(await inView(item.id), 'the app is in view without scrolling');
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-key="${item.id}"]').length`), 1, 'one copy on the page');
  // A new version is checked in a hidden frame before it shows; then exactly one frame runs it.
  await page.waitFor(`!!document.querySelector('[data-key="${item.id}"] iframe.app-iframe')`, { label: 'v2 to pass its check and load' });
  assert.equal(await page.evaluate(`document.querySelectorAll('iframe.app-iframe').length`), 1, 'one running frame');
  const line = await page.evaluate(`document.querySelector('[data-key="${stub}"]').textContent`);
  assert.match(line, /Pair explorer · updated to v2 below/);
  assert.match(line, /Go to it/);
});

await check('#49 scrolled up: an app leaving from above the view doesn’t move what you’re reading', async () => {
  const { t, tools, item } = room('Follows, scrolled up', 'follow-up', 18);
  await open(t);
  await wheel(-500);
  const at = await reading();
  assert.ok(at && at.key !== item.id, 'reading a message, not the app');
  assert.ok((await topOf(item.id)) < at.top, 'the app is above it');
  tools.update_app({ id: 'follow-up', code: APP('v2') });
  await stubOf(t, item.id);
  const moved = Math.abs((await topOf(at.key)) - at.top);
  assert.ok(moved <= 1, `the message you were reading moved ${moved} px`);
  assert.ok((await gap()) > 200, 'still scrolled up');
});

await check('#49 reading the app: its stub holds the place, and Go to it leads to the moved app', async () => {
  const { t, tools, item } = room('Follows while you read it', 'follow-read', 18);
  await open(t);
  await wheel(-300);
  await page.evaluate(`document.querySelector('[data-key="${item.id}"]').scrollIntoView({ block: 'center' })`);
  await wheel(-1);
  const at = await reading();
  assert.equal(at?.key, item.id, 'reading the app');
  const before = await topOf(item.id);
  tools.update_app({ id: 'follow-read', code: APP('v2') });
  const stub = await stubOf(t, item.id);
  const top = await topOf(stub);
  assert.ok(Math.abs(top - Math.max(0, before)) <= 1, `the stub is where the app was (${top}, was ${before})`);
  assert.ok((await gap()) > 200, 'the view didn’t jump to the bottom');
  await click(`document.querySelector('[data-key="${stub}"] button')`);
  await settle(600);
  assert.ok(await inView(item.id), 'Go to it brings the app into view');
  assert.ok(await page.evaluate(`!!document.activeElement?.closest('[data-key="${item.id}"]')`), 'and focuses it');
});

await check('#49 in the side panel: an app in a topic thread moves there, and the panel keeps what you read still', async () => {
  const { t } = room('Follows in a panel', 'follow-panel-root', 2);
  const root = store.items(t.id).find((i) => i.kind === 'agent');
  const { threadId } = rt.startTopic(t.id, root.id);
  const fork = rt.sessionsIn(t.id)[0]; // its one session answers in the thread (#228), so the app shows there
  rt.toolsFor(fork.id, /** @type {any} */ ({ threadId })).show_app({ id: 'follow-panel', title: 'Panel explorer', code: APP('v1'), permissions: [] });
  const item = store.items(threadId).find((i) => i.kind === 'block' && i.block.id === 'follow-panel');
  for (let i = 0; i < 16; i++)
    rt.addItem(threadId, { kind: 'agent', sessionId: fork.id, personaId: fork.personaId, handle: fork.handle, text: LONG(300 + i), status: 'done' });
  const hash = `#/t/${t.id}/side/${threadId}`;
  const inPanel = `document.querySelector('.sidepanel .transcript[data-thread="${threadId}"]')`;
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = '${hash}'`);
  await page.waitFor(`!!${inPanel}?.querySelector('.item')`, { label: 'the panel’s transcript' });
  await settle(400);
  const body = `${inPanel}.parentElement`;
  const panelGap = () => page.evaluate(`(() => { const b = ${body}; return Math.round(b.scrollHeight - b.scrollTop - b.clientHeight); })()`);
  const box = await page.evaluate(`(() => { const r = ${body}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const readingPanel = () =>
    page.evaluate(
      `(() => { const n = document.elementFromPoint(${box.x}, ${box.y})?.closest('.item'); return n ? { key: n.dataset.key, top: Math.round(n.getBoundingClientRect().top) } : null; })()`,
    );
  // Scrolled up in the panel, reading a message under the app.
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -500 });
  await settle();
  const at = await readingPanel();
  assert.ok(at && at.key !== item.id, 'reading a message in the panel');
  assert.ok((await panelGap()) > 200, 'the panel is scrolled up');
  rt.toolsFor(fork.id).update_app({ id: 'follow-panel', code: APP('v2') });
  const stubIn = (n) => store.items(threadId).filter((i) => i.kind === 'moved' && i.itemId === item.id)[n]?.id;
  const lastIs = `[...${inPanel}.children].filter((n) => n.dataset.key).at(-1)?.dataset.key === '${item.id}'`;
  await page.waitFor(`!!${inPanel}.querySelector('[data-key="${stubIn(0)}"]') && ${lastIs}`, { label: 'the stub and the app in the panel' });
  await settle(400);
  const moved = Math.abs((await topOf(at.key)) - at.top);
  assert.ok(moved <= 1, `the message you were reading in the panel moved ${moved} px`);
  assert.ok((await panelGap()) > 200, 'the panel is still scrolled up');
  // At the bottom of the panel, after more messages, the next version shows there, in view.
  for (let i = 0; i < 6; i++)
    rt.addItem(threadId, { kind: 'agent', sessionId: fork.id, personaId: fork.personaId, handle: fork.handle, text: LONG(400 + i), status: 'done' });
  await settle(400);
  await page.evaluate(`(() => { const b = ${body}; b.scrollTop = b.scrollHeight; })()`);
  await settle();
  rt.toolsFor(fork.id).update_app({ id: 'follow-panel', code: APP('v3') });
  await page.waitFor(`!!${inPanel}.querySelector('[data-key="${stubIn(1)}"]') && ${lastIs}`, { label: 'the second move in the panel' });
  await settle(400);
  assert.ok((await panelGap()) <= 2, `the panel stays at its bottom (gap ${await panelGap()})`);
  const shown = await page.evaluate(
    `(() => { const n = ${inPanel}.querySelector('[data-key="${item.id}"]').getBoundingClientRect(); const b = ${body}.getBoundingClientRect(); return n.top >= b.top - 1 && n.bottom <= b.bottom + 1; })()`,
  );
  assert.ok(shown, 'the app is in view in the panel');
  assert.equal(store.items(t.id).filter((i) => i.kind === 'moved').length, 0, 'the conversation itself has no stub');
});

await check('#92 a confirm that asks again shows at the bottom with a stub, ⌃J goes to it, and answering it records one answer', async () => {
  const { t, critic, say } = room('A block asks again', 'follow-block-app', 2);
  const tools = rt.toolsFor(critic.id);
  const block = (extra = {}) => ({
    id: 'frames',
    type: 'confirm',
    version: 1,
    fallback: 'Delete the frames?',
    statement: 'Delete the 23 video frames in app/media?',
    confirmLabel: 'Delete them',
    ...extra,
  });
  tools.show_block({ block: block() });
  const item = store.items(t.id).at(-1);
  rt.act(t.id, item.id, 'confirm', {}, 1);
  // The answer wakes critic, a mock agent: let that turn end first, so its reply lands before the update.
  await settle(100);
  for (let i = 0; i < 100 && rt.turns.has(critic.id); i++) await settle(100);
  rt.patchItem(t.id, item.id, { answer: { ...store.item(t.id, item.id).answer, read: true } });
  for (let i = 0; i < 14; i++) say(critic, LONG(200 + i));
  await open(t);
  assert.ok(!(await inView(item.id)), 'the answered confirm is out of view, above');
  tools.update_block({ block: block({ title: 'Video frames deleted', statement: 'Deleted. Anything else to clear?', confirmLabel: 'OK' }) });
  // Once updated, it’s the one agent that needs you, as #69 leaves it when a turn ends on a block that asks again.
  // ⌃J goes to the next agent that needs you, so none other does.
  for (const se of Object.values(store.state.sessions)) if (se.needs && se.id !== critic.id) rt.updateSession(se.id, { needs: null, state: 'idle' });
  rt.updateSession(critic.id, { state: 'needs', needs: { kind: 'block', itemId: item.id, text: 'Video frames deleted' } });
  const stub = await stubOf(t, item.id);
  assert.ok((await gap()) <= 2, 'the view stays at the bottom');
  assert.ok(await inView(item.id), 'the confirm is in view without scrolling');
  assert.match(await page.evaluate(`document.querySelector('[data-key="${stub}"]').textContent`), /Video frames deleted · asked again below/);
  // ⌃J goes to the moved block, from anywhere in the conversation, and focuses its button.
  await wheel(-2000);
  assert.ok(!(await inView(item.id)), 'scrolled away from it');
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, modifiers: 2 });
  // ⌃J scrolls on a short timer, which headless Chrome can hold back while nothing on screen changes.
  await page.waitFor(`!!document.activeElement?.closest('[data-key="${item.id}"]')`, { label: '⌃J to reach the moved confirm', timeout: 5000 }).catch(() => {});
  await settle();
  assert.ok(await inView(item.id), '⌃J brings the moved confirm into view');
  assert.ok(await page.evaluate(`!!document.activeElement?.closest('[data-key="${item.id}"]')`), 'and focuses it');
  await click(`[...document.querySelectorAll('[data-key="${item.id}"] button')].find((b) => b.textContent.trim() === 'OK')`);
  await page.waitFor(`document.querySelectorAll('.voice').length >= 2`, { label: 'your answer’s line' });
  const answered = store.item(t.id, item.id);
  assert.equal(answered.answer?.revision, 2, 'the answer is for the revision you saw');
  assert.equal(store.items(t.id).filter((i) => i.kind === 'voice').length, 2, 'one line for each answer');
});

await page.send('Page.navigate', { url: 'about:blank' });
await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
if (page.logs.length) console.log(`\nPage errors:\n  ${page.logs.join('\n  ')}`);
finish();
