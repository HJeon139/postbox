// A headless Chrome check of how the transcript follows agents, driven with real wheel and mouse input:
// the view stays on the newest message until you scroll up, and stays on what you’re reading after that
// (#88); apps name their author (#88); “Jump to latest” shows only while something is unread below (#91);
// the working rows sit in the message column (#83); and Summarize back and Send to conversation post once (#93).
//
//   node tools/check-transcript.mjs            (ONLY=#91 runs the cases whose name has that in it)
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory.
// PB_PORT and PB_CHROME_PORT move it, so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';

const PORT = Number(process.env.PB_PORT ?? 4580);
const CHROME_PORT = Number(process.env.PB_CHROME_PORT ?? 9780);

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-transcript-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;
const failures = [];

// ── Real input ──────────────────────────────────────────────────────────────────────────

// Headless Chrome can hold back animation frames while nothing on screen changes, so wait on a timer too.
const settle = (ms = 250) => page.evaluate(`new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, ${ms}); })`);
/** Turns the mouse wheel over the middle of the transcript, as a trackpad or mouse does. */
async function wheel(deltaY, { x = 760, y = 400 } = {}) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  await settle();
}
/** Clicks the middle of the element an expression finds, with the mouse, once or twice in a row. */
async function click(expr, { times = 1 } = {}) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  assert.ok(r, `Nothing to click: ${expr}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' });
  for (let i = 0; i < times; i++)
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await settle();
}
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((n) => n.textContent.includes(${JSON.stringify(text)}))`;
// How far the view is from the end of the conversation, and of the panel.
const gap = () => page.evaluate('Math.round(document.scrollingElement.scrollHeight - scrollY - innerHeight)');
const panelGap = () => page.evaluate(`(() => { const b = ${q('.sp-body')}; return b ? Math.round(b.scrollHeight - b.scrollTop - b.clientHeight) : null; })()`);
/** The message at the middle of the view, and where it starts; the same message must stay put. */
const reading = () =>
  page.evaluate(
    `(() => { const n = document.elementFromPoint(760, innerHeight / 2)?.closest('.item'); return n ? { key: n.dataset.key, top: Math.round(n.getBoundingClientRect().top) } : null; })()`,
  );
const topOf = (key) => page.evaluate(`Math.round(document.querySelector('[data-key="${key}"]')?.getBoundingClientRect().top ?? NaN)`);

async function check(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  let timer;
  try {
    // One case that hangs mustn’t block the rest.
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 45 s')), 45000);
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

// ── A long room with two agents ─────────────────────────────────────────────────────────

const persona = (handle) => Object.values(store.state.personas).find((p) => p.handle === handle);
const project = Object.values(store.state.projects)[0];
const LONG = (n) =>
  `Message ${n}. The ReAct loop alternates a thought, an action and an observation; the observation is the only outside evidence, so it keeps the plan grounded while the agent works through the search results one at a time.`;

function room(title, count = 24) {
  const t = rt.createThread({ projectId: project.id, title, personaIds: [persona('researcher').id, persona('critic').id] });
  const [researcher, critic] = rt.sessionsIn(t.id);
  const say = (se, text, extra = {}) =>
    rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done', ...extra });
  for (let i = 1; i <= count; i++) {
    if (i % 3 === 1) rt.addItem(t.id, { kind: 'user', text: `Question ${i}: what does the observation step add?` });
    else say(i % 2 ? critic : researcher, LONG(i));
  }
  return { t, researcher, critic, say };
}
/** Streams a reply a few words at a time, the way an agent does, and ends it. */
async function stream(t, se, text) {
  const it = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: '', status: 'streaming' });
  for (const chunk of text.match(/\S+\s*/g)) {
    store.emit('item.text', { threadId: t.id, id: it.id, text: chunk });
    await sleep(15);
  }
  rt.patchItem(t.id, it.id, { status: 'done' });
  return it;
}
// An app that starts short and grows to 700 px a moment after it loads.
const growingApp = (id, title, after = 1500) => ({
  id,
  title,
  fallback: `${title}: a box that grows.`,
  code: `<div id="b" style="height:150px">Loading the gallery…</div><script>setTimeout(() => { document.getElementById('b').style.height = '700px'; }, ${after});</script>`,
});
const frameHeight = (id) => page.evaluate(`Math.round(document.querySelector('[data-key="${id}"] iframe')?.getBoundingClientRect().height ?? 0)`);
const appItem = (t, appId) => store.items(t.id).find((i) => i.kind === 'block' && i.block?.id === appId)?.id;

async function open(hash) {
  if (await page.evaluate('location.origin === "null" || location.href === "about:blank"')) await page.goto(`${app.origin}/${hash}`);
  else await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await page.waitFor(`document.querySelector('.transcript .item')`, { label: 'the transcript' });
  await settle(400);
}

await page.size(1280, 900, { theme: 'light' });
await page.goto(`${app.origin}/#/`);

// ── #88: at the bottom, you stay at the bottom ──────────────────────────────────────────

await check('#88 at the bottom: streaming, a patch, a new item and the working row keep the view on the newest message', async () => {
  const { t, researcher, critic } = room('Stays at the bottom');
  await open(`#/t/${t.id}`);
  assert.ok((await gap()) <= 2, `opens at the bottom (gap ${await gap()})`);
  await stream(t, researcher, `${LONG(90)} ${LONG(91)} ${LONG(92)}`);
  await settle();
  assert.ok((await gap()) <= 2, `after streaming (gap ${await gap()})`);
  const last = store.items(t.id).at(-1);
  rt.patchItem(t.id, last.id, { activity: { steps: [{ id: 's1', label: 'grep observation', state: 'done', ms: 400 }] } });
  rt.patchItem(t.id, last.id, { sources: [{ title: 'ReAct', authors: 'Yao, Zhao', year: 2023, url: 'https://arxiv.org/abs/2210.03629' }] });
  await settle();
  assert.ok((await gap()) <= 2, `after an item patch grew the reply (gap ${await gap()})`);
  rt.updateSession(critic.id, { state: 'tool', currentStep: 'Searched the web for ReAct ablations', glimpse: 'Checking whether the ablation holds.' });
  await settle();
  assert.ok((await gap()) <= 2, `after the working row appeared (gap ${await gap()})`);
  rt.updateSession(critic.id, { state: 'idle', currentStep: '', glimpse: '' });
});

await check('#88 at the bottom: an app growing from 200 to 700 px leaves the view at the bottom, and the app names its author', async () => {
  const { t, critic } = room('An app grows');
  await open(`#/t/${t.id}`);
  rt.addItem(t.id, { kind: 'user', text: 'Show me the gallery.' });
  rt.toolsFor(critic.id).show_app(growingApp('gallery', 'Gallery', 2500));
  await page.waitFor(`document.querySelector('[data-key="${appItem(t, 'gallery')}"] iframe')`, { label: 'the app frame' });
  await page.waitFor(`document.querySelector('[data-key="${appItem(t, 'gallery')}"] iframe')?.getBoundingClientRect().height >= 690`, {
    label: 'the app to grow to 700 px',
  });
  await settle();
  assert.ok((await frameHeight(appItem(t, 'gallery'))) >= 690);
  assert.ok((await gap()) <= 2, `after the app grew (gap ${await gap()})`);
  const author = await page.evaluate(`document.querySelector('[data-key="${appItem(t, 'gallery')}"] .who b')?.textContent`);
  assert.equal(author, '@critic', 'the app’s header names the agent that wrote it');
  // The author line sits in the message column, like every other speaker line.
  const [appWho, colLeft] = await page.evaluate(
    `[document.querySelector('[data-key="${appItem(t, 'gallery')}"] .who').getBoundingClientRect().left, document.querySelector('.transcript .col.turn').getBoundingClientRect().left]`,
  );
  assert.equal(Math.round(appWho), Math.round(colLeft));
});

await check('#88 at the bottom: opening and closing the thread panel leaves the view at the bottom, in both panes', async () => {
  const { t, researcher } = room('Panel at the bottom');
  rt.toolsFor(researcher.id).show_app(growingApp('explainer', 'Explainer', 800));
  for (let i = 0; i < 3; i++) rt.addItem(t.id, { kind: 'user', text: `After the app ${i}` });
  await open(`#/t/${t.id}`);
  await page.waitFor(`document.querySelector('[data-key="${appItem(t, 'explainer')}"] iframe')?.getBoundingClientRect().height >= 690`, {
    label: 'the app to grow',
  });
  await settle();
  const root = store.items(t.id).find((i) => i.kind === 'agent');
  const { threadId } = rt.startTopic(t.id, root.id);
  for (let i = 0; i < 12; i++) rt.addItem(threadId, { kind: 'user', text: LONG(200 + i) });
  await open(`#/t/${t.id}/side/${threadId}`);
  await page.waitFor(q('.sidepanel'), { label: 'the panel' });
  // The app frame is rebuilt and grows again after the column narrows.
  await sleep(1500);
  await settle();
  assert.ok((await gap()) <= 2, `conversation, with the panel open (gap ${await gap()})`);
  assert.ok((await panelGap()) <= 2, `the panel itself (gap ${await panelGap()})`);
  await open(`#/t/${t.id}`);
  await sleep(1500);
  await settle();
  assert.ok((await gap()) <= 2, `after closing the panel (gap ${await gap()})`);
});

await check('#88 at the bottom: a window resize leaves the view at the bottom', async () => {
  const { t } = room('Resize at the bottom');
  await open(`#/t/${t.id}`);
  await page.size(1000, 700, { theme: 'light' });
  await settle(400);
  assert.ok((await gap()) <= 2, `narrower and shorter (gap ${await gap()})`);
  await page.size(1280, 900, { theme: 'light' });
  await settle(400);
  assert.ok((await gap()) <= 2, `back to 1280 (gap ${await gap()})`);
});

// ── #88: scrolled up, nothing moves you ─────────────────────────────────────────────────

await check('#88 scrolled up: streaming, patches, new items, an app growing above, the panel and a resize don’t move what you’re reading', async () => {
  const { t, researcher, critic, say } = room('Scrolled up', 6);
  rt.toolsFor(critic.id).show_app(growingApp('above', 'Above the view', 60000));
  // Enough below the app that it ends just above the view once you scroll up, where apps stay loaded.
  for (let i = 0; i < 16; i++) say(i % 2 ? critic : researcher, LONG(300 + i));
  await open(`#/t/${t.id}`);
  await wheel(-300);
  const at = await reading();
  assert.ok(at, 'a message is in view');
  assert.ok((await gap()) > 200, 'scrolled up');
  assert.ok(
    await page.evaluate(`document.querySelector('[data-key="${appItem(t, 'above')}"]').getBoundingClientRect().bottom < 48`),
    'the app is above the view',
  );
  // Within a pixel: scroll positions round to whole pixels.
  const still = async (what) => assert.ok(Math.abs((await topOf(at.key)) - at.top) <= 1, `${what} moved the message you were reading`);
  await stream(t, researcher, `${LONG(400)} ${LONG(401)}`);
  await settle();
  await still('streaming');
  rt.addItem(t.id, { kind: 'user', text: 'A new question below.' });
  await settle();
  await still('a new item');
  // A message above the one you’re reading grows (a patch re-renders it).
  const above = store.items(t.id).filter((i) => i.kind === 'agent')[2];
  rt.patchItem(t.id, above.id, { text: `${above.text}\n\n${LONG(500)}\n\n${LONG(501)}` });
  await settle();
  await still('a patch above');
  // The app above the view grows to 700 px. Chrome holds back rendering in a cross-origin frame that’s off
  // screen, so the app can’t measure itself there (and Postbox may have unloaded it to a placeholder of the same
  // height): set the height of what’s in its box, the way sizeFrame() does when an app reports one.
  await page.evaluate(`document.querySelector('[data-key="${appItem(t, 'above')}"] .app-body').firstElementChild.style.height = '700px'`);
  await settle();
  await still('the app above growing');
  await page.size(1100, 900, { theme: 'light' });
  await settle(400);
  const moved = Math.abs((await topOf(at.key)) - at.top);
  await page.size(1280, 900, { theme: 'light' });
  await settle(400);
  assert.ok(moved <= 1, `a resize moved it by ${moved} px`);
  // Opening the panel rebuilds the view around the conversation: you stay on the same message.
  const root = store.items(t.id).find((i) => i.kind === 'agent');
  const { threadId } = rt.startTopic(t.id, root.id);
  const before = await topOf(at.key);
  await open(`#/t/${t.id}/side/${threadId}`);
  await page.waitFor(q('.sidepanel'), { label: 'the panel' });
  await settle(400);
  assert.ok(Math.abs((await topOf(at.key)) - before) <= 1, `opening the panel moved it from ${before} to ${await topOf(at.key)}`);
  assert.ok((await gap()) > 200, 'still scrolled up with the panel open');
});

// ── #91: Jump to latest ─────────────────────────────────────────────────────────────────

await check('#91 the pill counts what arrives while you’re scrolled up, and goes once you scroll to the bottom yourself', async () => {
  const { t } = room('Jump to latest');
  await open(`#/t/${t.id}`);
  const pill = `(() => { const j = ${q('.jump')}; return j && !j.hidden ? j.textContent : ''; })()`;
  assert.equal(await page.evaluate(pill), '', 'no pill at the bottom');
  await wheel(-600);
  for (let i = 0; i < 3; i++) rt.addItem(t.id, { kind: 'user', text: `Arrived while you read ${i}` });
  await settle();
  assert.match(await page.evaluate(pill), /Jump to latest · 3 new/);
  // Down by hand, with the wheel, never touching the pill. (Keys scroll the same way, but Chrome animates a
  // key’s scroll, and headless Chrome holds that animation back.)
  for (let i = 0; i < 6; i++) await wheel(400);
  assert.ok((await gap()) <= 2, `at the bottom (gap ${await gap()})`);
  assert.equal(await page.evaluate(pill), '', 'the pill goes, and its count with it');
  rt.addItem(t.id, { kind: 'user', text: 'Arrived at the bottom' });
  await settle();
  assert.equal(await page.evaluate(pill), '', 'nothing is unread below');
  assert.ok((await gap()) <= 2, 'and the view followed it');
  await wheel(-600);
  rt.addItem(t.id, { kind: 'user', text: 'One more while you read' });
  await settle();
  assert.match(await page.evaluate(pill), /1 new/);
  // The pill is part of the composer, above its box, so it covers nothing the composer doesn’t.
  const inComposer = await page.evaluate(
    `(() => { const j = ${q('.jump')}.getBoundingClientRect(), c = ${q('.composer')}.getBoundingClientRect(), b = ${q('.composer-box')}.getBoundingClientRect(); return j.top >= c.top && j.bottom <= b.top; })()`,
  );
  assert.ok(inComposer, 'the pill sits inside the composer, above its box');
});

// ── #83: the working rows sit in the message column ─────────────────────────────────────

await check('#83 the working row lines up with the message column, with and without the panel, and a long step truncates', async () => {
  const { t, researcher, critic } = room('Working rows');
  await open(`#/t/${t.id}`);
  const step = `Searched the web for ${'ReAct observation ablations and the follow-up papers that cite them, '.repeat(6)}`;
  rt.updateSession(researcher.id, { state: 'tool', currentStep: step, glimpse: 'Reading the third result.' });
  rt.updateSession(critic.id, { state: 'think', glimpse: 'Is the ablation fair?' });
  await page.waitFor(`document.querySelectorAll('.working .work-row').length === 2`, { label: 'two working rows' });
  const measure = () =>
    page.evaluate(`(() => {
      const ring = document.querySelector('.working .work-row pb-ring').getBoundingClientRect();
      const who = [...document.querySelectorAll('.transcript .col.turn:not(.me) .who pb-ring')].at(-1).getBoundingClientRect();
      const col = [...document.querySelectorAll('.transcript .col.turn')].at(-1).getBoundingClientRect();
      const work = document.querySelector('.working').getBoundingClientRect();
      const line = document.querySelector('.working .work-line');
      return { ring: Math.round(ring.left), who: Math.round(who.left), colRight: Math.round(col.right), workRight: Math.round(work.right),
        truncated: line.scrollWidth > line.clientWidth && getComputedStyle(line).textOverflow === 'ellipsis', lineRight: Math.round(line.getBoundingClientRect().right) };
    })()`);
  const plain = await measure();
  assert.equal(plain.ring, plain.who, 'the ring and the @handle above share a left edge');
  assert.ok(plain.workRight <= plain.colRight, 'the rows end inside the column');
  assert.ok(plain.truncated && plain.lineRight <= plain.colRight, 'the long step truncates with an ellipsis, inside the column');
  const root = store.items(t.id).find((i) => i.kind === 'agent');
  const { threadId } = rt.startTopic(t.id, root.id);
  await open(`#/t/${t.id}/side/${threadId}`);
  await page.waitFor(`document.querySelectorAll('.main .working .work-row').length === 2`, { label: 'the rows with the panel open' });
  const panel = await measure();
  assert.equal(panel.ring, panel.who, 'with the panel open too');
  assert.ok(panel.workRight <= panel.colRight && panel.truncated, 'and still inside the column, truncated');
  rt.updateSession(researcher.id, { state: 'idle', currentStep: '', glimpse: '' });
  rt.updateSession(critic.id, { state: 'idle', glimpse: '' });
});

// ── #93: what goes back to the conversation goes once ───────────────────────────────────

await check('#93 Summarize back clicked twice posts one summary; the button waits, and the summary’s reply shows it was sent', async () => {
  const { t, researcher } = room('Summarize once', 6);
  const root = store.items(t.id).find((i) => i.kind === 'agent' && i.sessionId === researcher.id);
  const { threadId } = rt.startTopic(t.id, root.id);
  await open(`#/t/${t.id}/side/${threadId}`);
  await page.waitFor(byText('.sidepanel .btn', 'Summarize back'), { label: 'Summarize back' });
  await click(byText('.sidepanel .btn', 'Summarize back'), { times: 2 });
  const button = q('.sidepanel .sp-head .btn.sm:not(.icon)');
  assert.equal(await page.evaluate(`${button}.textContent`), 'Summary requested…');
  assert.ok(await page.evaluate(`${button}.disabled`), 'disabled while the summary is pending');
  const second = await fetch(`${app.origin}/api/threads/${threadId}/summarize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(second.status, 409, 'the server refuses a second request, as from another tab');
  await page.waitFor(`${button}.textContent === 'Summarize back' && !${button}.disabled`, { label: 'the button to come back', timeout: 15000 });
  const shared = store.items(t.id).filter((i) => i.kind === 'shared');
  assert.equal(shared.length, 1, 'one summary in the conversation');
  assert.equal(shared[0].summary, true);
  assert.equal(store.items(threadId).filter((i) => i.kind === 'voice').length, 1, 'one request');
  const reply = store.items(threadId).find((i) => i.kind === 'agent' && i.text);
  await page.waitFor(`document.querySelector('.sp-body [data-key="${reply.id}"] .msg-actions')?.textContent.includes('Sent to the conversation')`, {
    label: 'the reply to show it was sent',
  });
  assert.ok(!(await page.evaluate(`!!${byText(`.sp-body [data-key="${reply.id}"] .msg-actions button`, 'Send to conversation')}`)), 'no Send button on it');
});

await check('#93 Send to conversation clicked twice posts once', async () => {
  const { t, researcher } = room('Send once', 6);
  const root = store.items(t.id).find((i) => i.kind === 'agent' && i.sessionId === researcher.id);
  const { threadId } = rt.startTopic(t.id, root.id);
  const fork = rt.sessionsIn(threadId)[0];
  const reply = rt.addItem(threadId, {
    kind: 'agent',
    sessionId: fork.id,
    personaId: fork.personaId,
    handle: fork.handle,
    text: 'Offsets, not pages.',
    status: 'done',
  });
  await open(`#/t/${t.id}/side/${threadId}`);
  const send = byText(`.sp-body [data-key="${reply.id}"] .msg-actions button`, 'Send to conversation');
  await page.waitFor(send, { label: 'Send to conversation' });
  await click(send, { times: 2 });
  await page.waitFor(`document.querySelector('.sp-body [data-key="${reply.id}"] .msg-actions')?.textContent.includes('Sent to the conversation')`, {
    label: 'the reply to show it was sent',
  });
  await settle(400);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'shared').length, 1, 'posted once');
  // Without the wait, the second click reached the server, which refused it with an error toast.
  assert.ok(
    !(await page.evaluate(`[...document.querySelectorAll('.toast[role=alert]')].some((n) => n.textContent.includes('Couldn’t send it'))`)),
    'no “Couldn’t send it” error',
  );
});

await page.send('Page.navigate', { url: 'about:blank' });
await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
if (page.logs.length) console.log(`\nPage errors:\n  ${page.logs.join('\n  ')}`);
console.log(failures.length ? `\n${failures.length} failed.` : '\nAll transcript checks passed.');
process.exit(failures.length ? 1 : 0);
