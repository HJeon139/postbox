// Checks #193 in headless Chrome: an app its agent retired shows as one line where it was, with no sandbox. The
// line says who retired it and why, its link scrolls to the app that replaced it, and its version menu opens a
// version read-only, which Close puts back. Retiring moves nothing, and a new version brings the app back.
//
//   node tools/checks/app-retire.mjs
//
// PB_PORT and PB_CHROME_PORT move it (4900 and 10200 by default), so sessions working in parallel don’t collide.
// It reports through tools/harness.mjs: one line per assertion, and exit code 1 on any failure.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { launch, sleep } from '../cdp.mjs';
import { record as check, finish, ports } from '../harness.mjs';

const { PORT, CHROME_PORT } = await ports(4900, 10200);

const APP = (label) => `<main style="padding:12px"><p>${label}</p><button class="btn" type="button">Try it</button></main>`;

const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-app-retire-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
let page = null;

try {
  const { rt, store } = app;
  const projectId = Object.values(rt.s.projects)[0].id;
  const t = rt.createThread({
    projectId,
    title: 'Retire check',
    personaIds: [rt.personaByHandle('researcher').id, rt.personaByHandle('critic').id],
  });
  const [mine, theirs] = rt.sessionsIn(t.id).map((se) => rt.toolsFor(se.id));
  const ev = (x) => page.evaluate(x);
  const until = async (fn, label, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}. Apps: ${JSON.stringify(Object.values(rt.s.apps).map((a) => [a.id, a.check.status]))}`);
  };
  const item = (id) => `document.querySelector('.transcript > [data-key="${rt.s.apps[id].itemId}"]')`;

  page = await launch({ port: CHROME_PORT });
  await page.size(1280, 900, { theme: 'dark' });
  await page.goto(app.origin);
  mine.show_app({ id: 'lab', title: 'Practice lab', code: APP('Lab v1') });
  mine.update_app({ id: 'lab', code: APP('Lab v2'), summary: 'more exercises' });
  for (let i = 0; i < 12; i++) rt.addItem(t.id, { kind: 'user', text: `Message ${i}, so the map is off screen from the lab.` });
  theirs.show_app({ id: 'metro', title: 'Metro map', code: APP('The map') });
  await page.synced(store.state.seq);
  await ev(`location.hash = '#/t/${t.id}'`);
  await until(() => rt.s.apps.lab.check.status === 'passed' && rt.s.apps.metro.check.status === 'passed', 'both apps to pass their checks');
  await page.waitFor(`!!${item('lab')}?.querySelector('iframe.app-iframe')`, { label: 'the lab’s frame' });

  // 1. Retiring leaves one line where the app was, with no frame, and moves nothing.
  const before = store.items(t.id).map((x) => x.id);
  const r = mine.retire_app({ id: 'lab', reason: 'The metro map covers the same route.', replacedBy: 'metro' });
  check(r.ok, 'retire_app retires the agent’s own app', r.message);
  check(JSON.stringify(store.items(t.id).map((x) => x.id)) === JSON.stringify(before), 'retiring moves nothing in the conversation');
  await page.synced(store.state.seq);
  await page.waitFor(`!!${item('lab')}?.querySelector('.app-retired')`, { label: 'the retired line' });
  const line = await ev(`${item('lab')}.innerText`);
  check(/Practice lab/.test(line) && /Retired by @researcher: The metro map covers the same route\./.test(line), 'the line says who retired it and why', line);
  check(!(await ev(`!!${item('lab')}.querySelector('iframe')`)), 'a retired app runs no sandbox');
  check(!(await ev(`!!document.querySelector('iframe.check-frame[title="Checking Practice lab"]')`)), 'nor a check frame');
  const height = await ev(`${item('lab')}.querySelector('.app-retired').getBoundingClientRect().height`);
  check(height < 40, 'the line is one quiet line, not an app frame', `${height} px`);

  // In a narrow window, a long reason wraps inside the line.
  await page.size(375, 800, { theme: 'dark' });
  await sleep(300);
  const wide = await ev(
    `(() => { const l = ${item('lab')}.querySelector('.app-retired'); return [l.scrollWidth, l.clientWidth, document.documentElement.scrollWidth, innerWidth]; })()`,
  );
  check(wide[0] <= wide[1] + 1 && wide[2] <= wide[3], 'at 375 px the line fits its column', JSON.stringify(wide));
  await page.size(1280, 900, { theme: 'dark' });

  // 2. Its link scrolls to the app that replaced it, and moves focus there.
  await ev(`${item('lab')}.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  const hidden = await ev(`(() => { const r = ${item('metro')}.getBoundingClientRect(); return r.top >= innerHeight || r.bottom <= 0; })()`);
  check(hidden, 'the map starts off screen');
  await ev(`[...${item('lab')}.querySelectorAll('button')].find((b) => b.textContent === 'Go to Metro map').click()`);
  await sleep(300);
  const seen = await ev(`(() => { const r = ${item('metro')}.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; })()`);
  check(seen, 'Go to Metro map scrolls to the replacement');
  check(await ev(`${item('metro')}.contains(document.activeElement)`), 'and focus goes there');

  // 3. The version menu opens a version read-only, with a frame, and Close puts the line back.
  await ev(`${item('lab')}.scrollIntoView({ block: 'center' })`);
  await ev(`${item('lab')}.querySelector('[aria-haspopup="menu"]').click()`);
  await page.waitFor(`!!document.querySelector('.versions [role="menuitem"]')`, { label: 'the version menu' });
  const choices = await ev(`[...document.querySelectorAll('.versions [role="menuitem"]')].map((b) => b.innerText)`);
  check(choices.length === 2, 'the menu keeps both versions', JSON.stringify(choices));
  await ev(`[...document.querySelectorAll('.versions [role="menuitem"]')].find((b) => /^v1\\b/.test(b.innerText)).click()`);
  await page.waitFor(`!!${item('lab')}?.querySelector('iframe.app-iframe')`, { label: 'v1’s frame' });
  const note = await ev(`${item('lab')}.querySelector('.app-note')?.innerText ?? ''`);
  check(/Viewing v1, read-only/.test(note) && /Close/.test(note), 'an opened version is read-only, with Close', note);
  await ev(`[...${item('lab')}.querySelectorAll('.app-note button')].find((b) => b.textContent === 'Close').click()`);
  await page.waitFor(`!!${item('lab')}?.querySelector('.app-retired')`, { label: 'the line again' });
  check(!(await ev(`!!${item('lab')}.querySelector('iframe')`)), 'Close puts the line back, with no frame');

  // 4. A new version brings it back, at the newest point.
  const u = mine.update_app({ id: 'lab', code: APP('Lab v3'), summary: 'the route in the lab' });
  check(u.ok && store.items(t.id).at(-1).id === rt.s.apps.lab.itemId, 'update_app brings a retired app back at the newest point', u.message);
  await page.synced(store.state.seq);
  await until(() => rt.s.apps.lab.check.status === 'passed', 'v3 to pass its check');
  await page.waitFor(`!!${item('lab')}?.querySelector('iframe.app-iframe')`, { label: 'v3’s frame' });
  check(!(await ev(`!!${item('lab')}.querySelector('.app-retired')`)), 'and its line is gone');
} catch (e) {
  check(false, 'the check ran to the end', e.stack ?? e.message);
} finally {
  await page?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
finish();
