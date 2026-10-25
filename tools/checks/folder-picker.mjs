// A headless Chrome check that the folder picker stays usable around symbolic links (#28): a link that leads out of
// the project’s folder is marked and offers no Open or Attach, a link inside it opens as a folder, and a folder
// that won’t open (it became a link out since it was listed) says why above the list, which stays, with its Up.
//
//   node tools/checks/folder-picker.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory, and adds
// a project whose folder, also in the temp directory, holds the links. PB_PORT and PB_CHROME_PORT move it (4886
// and 10186 by default), so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { js, launch } from '../cdp.mjs';
import { finish, ports, record } from '../harness.mjs';

const { PORT, CHROME_PORT } = await ports(4886, 10186);

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-folder-picker-'));
// The project’s folder, and a folder beside it that its links lead to.
const scratch = await mkdtemp(join(tmpdir(), 'pb-check-folder-picker-files-'));
const root = join(scratch, 'project');
const away = join(scratch, 'elsewhere');
await mkdir(join(root, 'docs', 'later'), { recursive: true });
await mkdir(away);
await writeFile(join(root, 'notes.txt'), 'notes');
await writeFile(join(root, 'docs', 'guide.md'), '# Guide');
await writeFile(join(away, 'secret.txt'), 'not for the picker');
await symlink(away, join(root, 'away-link'));
await symlink(join(away, 'secret.txt'), join(root, 'secret-link.txt'));
await symlink(join(root, 'docs'), join(root, 'docs-link'));

const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;

const settle = (ms = 250) => page.evaluate(`new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, ${ms}); })`);
async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  assert.ok(r, `Nothing to click: ${expr}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
async function check(name, fn) {
  let timer;
  try {
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
}
/** The listed entry named `name`: its row’s words, and the names of the buttons in it. */
const row = (name) =>
  page.evaluate(
    `(() => { const li = [...document.querySelectorAll('.d-body li')].find((l) => l.querySelector('.grow')?.textContent === ${js(name)}); return li ? { text: li.textContent, buttons: [...li.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent) } : null; })()`,
  );
const button = (label) =>
  `[...document.querySelectorAll('.d-body li button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${js(label)})`;
const where = () => page.evaluate(`document.querySelector('.d-body p.mono').textContent`);

const project = { id: 'pr-links', name: 'Linked files', folder: root };
store.emit('project', project);
const librarian = Object.values(store.state.personas).find((p) => p.handle === 'librarian');
const t = rt.createThread({ projectId: project.id, title: 'Links', personaIds: [librarian.id] });

await page.size(1280, 900);
await page.goto(`${app.origin}/#/t/${t.id}`);
await page.waitFor(`document.querySelector('button[aria-label="Add a file or a new agent"]')`, { label: 'the composer’s +' });
await click(`document.querySelector('button[aria-label="Add a file or a new agent"]')`);
await click(`[...document.querySelectorAll('.menu .mi')].find((b) => b.textContent.includes('From the project folder'))`);
await page.waitFor(`document.querySelector('.d-body li button')`, { label: 'the folder picker’s list' });

await check('#28 a link out of the project’s folder is marked, with no Open or Attach', async () => {
  const dir = await row('away-link');
  assert.ok(dir, 'away-link isn’t listed');
  assert.match(dir.text, /Link to outside the project/);
  assert.deepEqual(dir.buttons, []);
  const file = await row('secret-link.txt');
  assert.ok(file, 'secret-link.txt isn’t listed');
  assert.match(file.text, /Link to outside the project/);
  assert.deepEqual(file.buttons, []);
  // What’s really in the folder is listed as before.
  assert.deepEqual((await row('docs'))?.buttons, ['Open docs']);
  assert.deepEqual((await row('notes.txt'))?.buttons, ['Attach notes.txt']);
});

await check('#28 a link that stays inside the project’s folder opens the folder it leads to', async () => {
  assert.deepEqual((await row('docs-link'))?.buttons, ['Open docs-link']);
  await click(button('Open docs-link'));
  await page.waitFor(`${button('Attach guide.md')}`, { label: 'docs-link’s files' });
  // It shows the folder it leads to.
  assert.match(await where(), /\/project\/docs$/);
  await click(button('Up'));
  await page.waitFor(`${button('Open docs')}`, { label: 'the project’s folder again' });
});

await check('#28 a folder that won’t open says why above the list, which stays, with Up', async () => {
  await click(button('Open docs'));
  await page.waitFor(`${button('Open later')}`, { label: 'docs’s folders' });
  // Since it was listed, docs/later became a link out of the project.
  await rm(join(root, 'docs', 'later'), { recursive: true });
  await symlink(away, join(root, 'docs', 'later'));
  await click(button('Open later'));
  await page.waitFor(`!document.querySelector('.d-body .err[role=alert]')?.hidden`, { label: 'the error' });
  assert.equal(await page.evaluate(`document.querySelector('.d-body .err[role=alert]').textContent`), 'That’s outside the project’s folder.');
  assert.match(await where(), /\/docs$/);
  assert.ok(await page.evaluate(`!!${button('Up')} && !!${button('Attach guide.md')}`), 'the list or its Up is gone');
  // Up leads back out, and the error goes with it.
  await click(button('Up'));
  await page.waitFor(`${button('Open docs')}`, { label: 'the project’s folder again' });
  assert.equal(await page.evaluate(`document.querySelector('.d-body .err[role=alert]').hidden`), true);
});

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
await rm(scratch, { recursive: true, force: true });
if (page.logs.length) console.log(`\nPage errors:\n  ${page.logs.join('\n  ')}`);
finish();
