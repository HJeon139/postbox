// A headless Chrome check that the conversation’s composer never covers what has focus (#232, WCAG 2.4.11 Focus
// Not Obscured). The composer sticks to the bottom of the window, over the end of the conversation, and the browser
// scrolls a control you Tab to only as far as the window’s edge. With the view a little above the end:
//   - Tabbing through the last replies, through their buttons, a choice’s options and its Send, leaves each one in
//     view above the composer;
//   - so does it while the Jump to latest pill floats above the composer;
//   - Shift+Tab from the composer to the last control of the conversation does too;
//   - a click on a message under the composer, which focuses it, doesn’t move the view;
//   - Tabbing in a review open full screen doesn’t scroll the conversation behind it.
// At 1280 and 375 px.
//
//   node tools/checks/focus-clear.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory.
// PB_PORT and PB_CHROME_PORT move it (5410 and 10710 by default), so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { launch } from '../cdp.mjs';
import { finish, ports, record } from '../harness.mjs';

const { PORT, CHROME_PORT } = await ports(5410, 10710);

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-focus-clear-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;

const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
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
}
/** Presses Tab, or Shift+Tab, the way a keyboard does. */
async function tab({ shift = false } = {}) {
  const base = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: shift ? 8 : 0 };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await settle();
}
// What has focus, whether it’s in the composer, and how much of it the composer or the pill above it covers.
const FOCUS = `(() => {
  const a = document.activeElement;
  const composer = document.getElementById('composer-input').closest('.composer');
  const r = a.getBoundingClientRect();
  const covered = [composer, composer.querySelector('.jump')].map((n) => n.getBoundingClientRect()).filter((c) => c.height).map((c) => {
    const across = Math.min(r.right, c.right) - Math.max(r.left, c.left);
    return across > 0 ? Math.max(0, Math.round(Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top))) : 0;
  });
  return { name: (a.getAttribute('aria-label') ?? a.textContent).trim().slice(0, 40) || a.tagName, inComposer: !!a.closest('.composer'), covered: Math.max(...covered) };
})()`;
/** Tabs from a control in the third reply from the end until focus reaches the composer: what it went through. */
async function tabThrough() {
  const from = await page.evaluate(
    `(() => { const items = [...document.querySelectorAll('#main > .item')]; const b = items.at(-3).querySelector('button'); b.focus({ preventScroll: true }); return document.activeElement === b; })()`,
  );
  assert.ok(from, 'nothing to start from in the third reply from the end');
  const seen = [];
  for (let i = 0; i < 30; i++) {
    await tab();
    const f = await page.evaluate(FOCUS);
    if (f.inComposer) break;
    seen.push(f);
  }
  assert.ok(seen.length >= 5, `only ${seen.length} controls before the composer`);
  return seen;
}

const project = Object.values(store.state.projects)[0];
const librarian = Object.values(store.state.personas).find((p) => p.handle === 'librarian');
const t = rt.createThread({ projectId: project.id, title: 'Focus at the foot', personaIds: [librarian.id] });
const se = rt.sessionsIn(t.id)[0];
for (let i = 1; i <= 12; i++) {
  rt.addItem(t.id, { kind: 'user', text: `Question ${i}: which shelf holds the 1874 Middlemarch?` });
  rt.addItem(t.id, {
    kind: 'agent',
    sessionId: se.id,
    personaId: se.personaId,
    handle: se.handle,
    text: `Answer ${i}: the third shelf, by the window.`,
    status: 'done',
  });
}
// A long reply, which runs on under the composer once the view is a little above the end.
const LONG = Array.from({ length: 6 }, (_, i) => `Shelf note ${i + 1}: the 1874 Middlemarch sits with the other first editions, spine out, by the window.`);
rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: LONG.join('\n\n'), status: 'done' });
rt.toolsFor(se.id).show_block({
  block: {
    id: 'shelf',
    type: 'choice',
    version: 1,
    title: 'Which shelf next?',
    fallback: 'Which shelf next?',
    options: ['Third', 'Fourth', 'Fifth'].map((l) => ({ id: l.toLowerCase(), label: l })),
  },
});

/** Opens the conversation at its end, then scrolls up a little, so its last replies are under the composer. */
async function nearTheEnd(width) {
  await page.size(width, 800, { theme: 'dark' });
  await page.goto('about:blank');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await page.synced(store.state.seq);
  await page.waitFor(`document.querySelector('.chips .chip')`);
  await settle();
  await page.evaluate('scrollBy(0, -240)');
  await settle();
}

for (const width of [1280, 375]) {
  await check(`#232 at ${width} px: Tabbing through the last replies leaves each control in view above the composer`, async () => {
    await nearTheEnd(width);
    assert.deepEqual(
      (await tabThrough()).filter((f) => f.covered),
      [],
      'the composer covers what has focus',
    );
  });
  await check(`#232 at ${width} px: with Jump to latest showing, Tabbing through the last replies leaves each control clear of it`, async () => {
    await nearTheEnd(width);
    // A reply that arrives while you’re scrolled up brings the pill, which floats above the composer.
    rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: 'One more: the fourth shelf too.', status: 'done' });
    await page.synced(store.state.seq);
    await page.waitFor(`!document.querySelector('.jump').hidden`, { label: 'the Jump to latest pill' });
    assert.deepEqual(
      (await tabThrough()).filter((f) => f.covered),
      [],
      'the composer or the pill covers what has focus',
    );
  });
  await check(`#232 at ${width} px: Shift+Tab from the composer to the conversation’s last control leaves it in view`, async () => {
    await nearTheEnd(width);
    // Focus in the composer, with the view still a little above the end: you scrolled up to read, say.
    await page.evaluate(`document.getElementById('composer-input').focus({ preventScroll: true })`);
    await settle();
    assert.ok(await page.evaluate('document.scrollingElement.scrollHeight - innerHeight - scrollY > 100'), 'the view went back to the end');
    let f;
    for (let i = 0; i < 6 && (!f || f.inComposer); i++) {
      await tab({ shift: true });
      f = await page.evaluate(FOCUS);
    }
    assert.ok(f && !f.inComposer, 'Shift+Tab never left the composer');
    assert.equal(f.covered, 0, `the composer covers ${f.covered} px of “${f.name}”`);
  });
  await check(`#232 at ${width} px: a click on a message under the composer doesn’t move the view`, async () => {
    await nearTheEnd(width);
    // A point in a message, at its edge, just above the composer, in a message that runs on under it.
    const at = await page.evaluate(`(() => {
      const top = document.getElementById('composer-input').closest('.composer').getBoundingClientRect().top;
      const n = [...document.querySelectorAll('#main > .item')].find((i) => { const r = i.getBoundingClientRect(); return r.top < top - 12 && r.bottom > top; });
      return n ? { x: n.getBoundingClientRect().left + 4, y: top - 6 } : null;
    })()`);
    assert.ok(at, 'no message runs on under the composer');
    const before = await page.evaluate('scrollY');
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
    await settle();
    assert.equal(await page.evaluate('scrollY'), before, 'the view moved');
  });
}

await check('#232: Tabbing in a review open full screen doesn’t scroll the conversation behind it', async () => {
  rt.toolsFor(se.id).show_block({
    block: {
      id: 'plan',
      type: 'review',
      version: 1,
      title: 'shelves.md',
      fallback: 'The shelf plan',
      format: 'markdown',
      content: `# Shelves\n\n${Array.from({ length: 60 }, (_, i) => `- Shelf ${i + 1}: first editions.`).join('\n')}`,
    },
  });
  await nearTheEnd(1280);
  await page.evaluate(`document.querySelector('.rv-full-btn').click()`);
  await page.waitFor(`document.querySelector('.rv-box.rv-full')`, { label: 'the review, full screen' });
  const before = await page.evaluate('scrollY');
  // Round the review’s controls twice: its bar sticks to the foot of the window, where the composer is behind it.
  for (let i = 0; i < 16; i++) await tab();
  assert.ok(await page.evaluate(`!!document.activeElement.closest('.rv-full')`), 'focus left the full-screen review');
  assert.equal(await page.evaluate('scrollY'), before, 'the conversation behind it scrolled');
});

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
if (page.logs.length) console.log(`\nPage errors:\n  ${page.logs.join('\n  ')}`);
finish();
