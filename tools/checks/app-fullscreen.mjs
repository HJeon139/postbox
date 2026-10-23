// Checks #45 in headless Chrome: an agent app’s full-screen button fills the window with the app, without
// reloading it, and Escape (pressed on the page or inside the app) brings it back, with focus on the button.
// It starts its own fresh Postbox and Chrome, adds an app with two versions through the runtime, and uses real
// (trusted) input from the DevTools protocol.
//
//   node tools/checks/app-fullscreen.mjs
//
// PB_PORT and PB_CHROME_PORT move it (4413 and 9613 by default), so sessions working in parallel don’t collide.
// It reports through tools/harness.mjs: one line per assertion, and exit code 1 on any failure.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { launch, sleep } from '../cdp.mjs';
import { record as check, finish, ports } from '../harness.mjs';

const { PORT, CHROME_PORT } = await ports(4413, 9613);

// Counts its loads in saved state, so a reload shows up as a second load.
const APP = (
  label,
) => `<main style="padding:12px"><button id="b" class="btn" type="button" style="display:block;width:100%;height:80px">${label}</button></main>
<script>
postbox.ready.then((r) => { if (!postbox.check) postbox.saveState({ loads: ((r.state && r.state.loads) || 0) + 1 }); });
</script>`;

// Grows to 1200 px when you press its button.
const GROW = `<main style="padding:12px"><button id="g" class="btn" type="button" style="display:block;width:100%;height:80px">Grow</button><div id="x"></div></main>
<script>document.getElementById('g').addEventListener('click', () => { document.getElementById('x').style.height = '1200px'; });</script>`;
// Uses Escape itself (to close its own menu, say), and says so with preventDefault.
const OWN_ESCAPE = `<main style="padding:12px"><button class="btn" type="button" style="display:block;width:100%;height:80px">Has its own Escape</button></main>
<script>addEventListener('keydown', (e) => { if (e.key === 'Escape') e.preventDefault(); });</script>`;

const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-app-full-'));
process.env.POSTBOX_MOCK_SPEED = '0.1';
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
let page = null;

try {
  const { rt } = app;
  const projectId = Object.values(rt.s.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Full-screen check', personaIds: [rt.personaByHandle('librarian').id] });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  const until = async (fn, label, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}. Apps: ${JSON.stringify(Object.values(rt.s.apps).map((a) => [a.id, a.check.status]))}`);
  };
  const ev = (x) => page.evaluate(x);
  // A conversation made a moment ago must have reached the page first: one it hasn’t heard of opens the overview.
  const go = async (hash) => {
    await page.synced(app.store.state.seq);
    await ev(`location.hash = '${hash}'`);
  };
  const click = async (x, y) => {
    // A pointer rests on what it clicks for a moment, as a hand does; an app frame needs it to see you point (#38).
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(100);
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const clickEl = async (expr) => {
    const r = await ev(
      `(() => { const el = ${expr}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
    );
    if (!r) throw new Error(`Couldn’t find ${expr}.`);
    await click(r.x, r.y);
  };
  const key = async (k, code) => {
    for (const type of ['keyDown', 'keyUp'])
      await page.send('Input.dispatchKeyEvent', {
        type,
        key: k,
        code: k,
        windowsVirtualKeyCode: code,
        ...(type === 'keyDown' && k === 'Enter' ? { text: '\r' } : {}),
      });
    await sleep(300);
  };
  const BTN = `document.querySelector('.appframe [aria-label="Full screen"], .appframe [aria-label="Exit full screen"], .appframe [aria-label="Expand"], .appframe [aria-label="Collapse"]')`;
  const FRAME = `document.querySelector('iframe.app-iframe')`;
  const frameBox = () => ev(`(() => { const b = ${FRAME}.getBoundingClientRect(); return { w: b.width, h: b.height, W: innerWidth, H: innerHeight }; })()`);
  const loads = () => rt.s.apps.full?.state?.loads ?? 0;
  const label = () => ev(`${BTN}?.getAttribute('aria-label')`);

  page = await launch({ port: CHROME_PORT });
  await page.size(1280, 900, { theme: 'dark' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  tools.show_app({ id: 'full', title: 'Full', code: APP('Version one'), permissions: [] });
  await until(() => ['passed', 'note'].includes(rt.s.apps.full?.check.status), 'the app to pass its check');
  tools.update_app({ id: 'full', code: APP('Version two') });
  await until(() => ['passed', 'note'].includes(rt.s.apps.full?.check.status) && rt.s.apps.full.current === 2, 'v2 to pass its check');
  await until(() => ev(`!!${FRAME}?.dataset.sized`), 'the frame to load');
  await until(() => loads() >= 1, 'the app to save its first load');
  await sleep(500);
  const before = await frameBox();
  const loadsBefore = loads();

  // 1. Full screen, with a real click.
  check((await label()) === 'Full screen', 'the button is labeled “Full screen”', await label());
  await ev(`${BTN}.scrollIntoView({ block: 'center' })`);
  await clickEl(BTN);
  await sleep(300);
  const inFull = await frameBox();
  check(await ev(`!!document.querySelector('.fullscreen .appframe')`), 'the app’s box is in a full-screen overlay');
  check(
    inFull.w >= 0.9 * inFull.W && inFull.h >= 0.9 * inFull.H,
    'the frame fills at least 90% of the window',
    `${Math.round(inFull.w)}×${Math.round(inFull.h)} of ${inFull.W}×${inFull.H}, was ${Math.round(before.w)}×${Math.round(before.h)}`,
  );
  check(await ev(`!!document.activeElement?.closest('.fullscreen')`), 'focus moves into the overlay');
  check((await label()) === 'Exit full screen', 'the same button now says “Exit full screen”', await label());
  check((await ev(`document.querySelectorAll('iframe.app-iframe').length`)) === 1, 'no second copy of the app runs');

  // 2. The version menu opens above the overlay, and Escape closes the menu first.
  await clickEl(`document.querySelector('.fullscreen .appframe [aria-haspopup="menu"]')`);
  const menuOnTop = await ev(
    `(() => { const m = document.querySelector('.menu'); if (!m) return false; const b = m.getBoundingClientRect(); return m.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); })()`,
  );
  check(menuOnTop, 'the version menu shows above the full-screen app');
  await key('Escape', 27);
  check(
    (await ev(`!document.querySelector('.menu')`)) && (await ev(`!!document.querySelector('.fullscreen .appframe')`)),
    'Escape closes the menu and stays full screen',
  );

  // 3. Escape leaves full screen, and focus returns to the button.
  await ev(`${BTN}.focus()`);
  await key('Escape', 27);
  const after = await frameBox();
  check(await ev(`!document.querySelector('.fullscreen')`), 'Escape leaves full screen');
  check(Math.abs(after.h - before.h) < 2 && Math.abs(after.w - before.w) < 2, 'the frame is back to its size in the column', `${after.w}×${after.h}`);
  check((await ev(`document.activeElement === ${BTN}`)) && (await label()) === 'Full screen', 'focus returns to the button, labeled “Full screen” again');

  // 4. Escape pressed inside the app (focus in its frame) leaves full screen too.
  await clickEl(BTN);
  await clickEl(`document.querySelector('.fullscreen iframe.app-iframe')`);
  const inFrame = await ev(`document.activeElement === ${FRAME}`);
  await key('Escape', 27);
  check(
    inFrame && (await ev(`!document.querySelector('.fullscreen')`)) && (await ev(`document.activeElement === ${BTN}`)),
    'Escape inside the app leaves full screen, and focus returns to the button',
  );

  // 5. The close button, by keyboard (Enter on the focused button), both ways.
  await key('Enter', 13);
  const opened = await ev(`!!document.querySelector('.fullscreen')`);
  await key('Enter', 13);
  check(opened && (await ev(`!document.querySelector('.fullscreen')`)), 'the button opens and closes full screen by keyboard');

  await sleep(800);
  check(loads() === loadsBefore, 'the app never reloaded (its saved state counted one load)', `${loads()} loads, was ${loadsBefore}`);

  // 6. Switching versions while full screen re-renders the app in place, still full screen.
  await clickEl(BTN);
  await clickEl(`document.querySelector('.fullscreen .appframe [aria-haspopup="menu"]')`);
  await clickEl(`[...document.querySelectorAll('.menu .mi')].find((b) => b.textContent.startsWith('v1'))`);
  await until(() => ev(`!!document.querySelector('.fullscreen .app-note')`), 'v1 to show').catch(() => {});
  const v1 = await frameBox().catch(() => ({ w: 0, h: 0, W: 1, H: 1 }));
  check(
    (await ev(`/Viewing v1/.test(document.querySelector('.fullscreen')?.textContent ?? '')`)) && v1.h >= 0.8 * v1.H,
    'an older version opens in the same full-screen view',
  );
  check(await ev(`!!document.activeElement?.closest('.fullscreen')`), 'focus stays in the overlay after the switch');
  // Tab past the last control comes back into the overlay.
  for (let i = 0; i < 6; i++) await key('Tab', 9);
  check(await ev(`!!document.activeElement?.closest('.fullscreen')`), 'Tab keeps focus inside the overlay');
  await ev(`${BTN}.focus()`);
  await key('Escape', 27);
  check(await ev(`!document.querySelector('.fullscreen')`), 'Escape still leaves full screen after the switch');

  // 7. Two more apps, in another conversation.
  const t2 = rt.createThread({ projectId, title: 'Full-screen check 2', personaIds: [rt.personaByHandle('librarian').id] });
  const tools2 = rt.toolsFor(rt.sessionsIn(t2.id)[0].id);
  await go(`#/t/${t2.id}`);
  tools2.show_app({ id: 'grow', title: 'Grow', code: GROW, permissions: [] });
  tools2.show_app({ id: 'own-escape', title: 'Own escape', code: OWN_ESCAPE, permissions: [] });
  const box = (title) => `[...document.querySelectorAll('.appframe')].find((n) => n.querySelector('.title')?.textContent === ${JSON.stringify(title)})`;
  const btnOf = (title) => `${box(title)}?.querySelector('.app-bar button.icon')`;
  const frameOf = (title) => `${box(title)}?.querySelector('iframe.app-iframe')`;
  for (const id of ['grow', 'own-escape']) await until(() => ['passed', 'note'].includes(rt.s.apps[id]?.check.status), `${id} to pass its check`);
  await until(() => ev(`!!${frameOf('Grow')}?.dataset.sized && !!${frameOf('Own escape')}?.dataset.sized`), 'both frames to load');
  await sleep(500);

  // The app grows while full screen: back in the column it’s as tall as the column allows, not its old height.
  await ev(`${box('Grow')}.scrollIntoView({ block: 'center' })`);
  await clickEl(btnOf('Grow'));
  const g = await ev(`(() => { const b = ${frameOf('Grow')}.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 50 }; })()`);
  await click(g.x, g.y);
  await sleep(500);
  await ev(`${btnOf('Grow')}.focus()`);
  await key('Escape', 27);
  await sleep(800);
  const grown = await ev(`({ h: ${frameOf('Grow')}.getBoundingClientRect().height, cap: Math.min(innerHeight * 0.8, 760) })`);
  check(Math.abs(grown.h - grown.cap) < 2, 'an app that grew while full screen comes back as tall as the column allows', `${grown.h} px, cap ${grown.cap} px`);

  // An app that uses Escape itself keeps full screen.
  await ev(`${box('Own escape')}.scrollIntoView({ block: 'center' })`);
  await clickEl(btnOf('Own escape'));
  const o = await ev(`(() => { const b = ${frameOf('Own escape')}.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 50 }; })()`);
  await click(o.x, o.y);
  const inOwn = await ev(`document.activeElement === ${frameOf('Own escape')}`);
  await key('Escape', 27);
  await sleep(300);
  check(inOwn && (await ev(`!!document.querySelector('.fullscreen')`)), 'Escape an app handles itself doesn’t leave full screen', `in the app: ${inOwn}`);
  await ev(`${btnOf('Own escape')}.focus()`);
  await key('Escape', 27);

  // Full screen ends with the view: leave the conversation while full screen, and come back.
  await clickEl(btnOf('Grow'));
  await go(`#/t/${t.id}`);
  await sleep(800);
  await go(`#/t/${t2.id}`);
  await sleep(1200);
  check(await ev(`!document.querySelector('.fullscreen')`), 'coming back to the conversation doesn’t open the app full screen');
  // And Escape on another page after leaving one full screen isn’t taken by it.
  if (await ev(`!!document.querySelector('.fullscreen')`)) await ev(`${btnOf('Grow')}.click()`);
  await ev(`${box('Grow')}.scrollIntoView({ block: 'center' })`);
  await clickEl(btnOf('Grow'));
  await go(`#/t/${t.id}`);
  await sleep(800);
  await ev(`window.__esc = null; addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__esc = e.defaultPrevented; })`);
  await ev(`document.activeElement?.blur?.()`);
  await key('Escape', 27);
  check(
    (await ev('window.__esc')) === false,
    'Escape on another page isn’t taken by a full screen that’s gone',
    `defaultPrevented: ${await ev('window.__esc')}`,
  );
} catch (e) {
  check(false, 'the check ran to the end', e.message);
} finally {
  await page?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
finish();
