// A headless Chrome check of what the persona sheet says an agent runs with: your MCP servers, each with its
// status and a checkbox that’s on by default (#59), and that saving stores the ones turned off.
//
//   node tools/check-runtime.mjs
//
// It starts its own Postbox on a fresh temp data folder (demo mode, with a stand-in Claude Code backend so the
// real backend’s fields show) and Chrome. The person’s Claude Code config comes from a fake home folder in the
// temp directory (start()’s claudeHome), so it never reads the real one. PB_PORT and PB_CHROME_PORT move them
// (4410 and 9610 by default). It prints one PASS or FAIL line per assertion and exits non-zero on any failure.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';

const PORT = Number(process.env.PB_PORT ?? 4410);
const CHROME_PORT = Number(process.env.PB_CHROME_PORT ?? 9610);

/** Fails fast when something else already listens on a port this check needs. */
const free = (port) =>
  new Promise((ok, fail) => {
    const s = createServer()
      .once('error', () => fail(new Error(`Port ${port} is in use. Stop whatever runs there, then try again.`)))
      .once('listening', () => s.close(() => ok(true)))
      .listen(port, '127.0.0.1');
  });

let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${!ok && detail ? ` (${detail})` : ''}`);
};

await free(PORT);
await free(CHROME_PORT);
const root = await mkdtemp(join(tmpdir(), 'pb-check-runtime-'));
const dataDir = join(root, 'data');
// A fake home folder with one user-scope server, and an agent folder with an approved project server. The secret
// stands for what a real config can hold: it must never reach the page.
const home = join(root, 'home');
const folder = join(root, 'work');
await mkdir(join(folder, '.claude'), { recursive: true });
await mkdir(home, { recursive: true });
await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { search: { command: 'search-server', env: { TOKEN: 'secret-token-123' } } } }));
await writeFile(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }));
await writeFile(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));

process.env.POSTBOX_BACKENDS = 'mock';
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true, claudeHome: home });
/** @type {any} */
let page = null;
try {
  // A stand-in for the Claude Code backend: it never runs a turn here, it only makes the real fields show.
  app.rt.adapters.register({ name: 'claude-code', deliver: async () => {} });
  const persona = app.rt.createPersona({ handle: 'checker', backend: 'claude-code', folder });
  const projectId = Object.keys(app.store.state.projects)[0];
  // What a turn’s init would have reported: Postbox’s own server, the user server, and a claude.ai connector.
  const t = app.rt.createThread({ projectId, title: 'Check', personaIds: [persona.id] });
  const se = app.rt.sessionsIn(t.id)[0];
  app.rt.updateSession(se.id, {
    backend: 'claude-code',
    mcpServers: {
      at: Date.now(),
      servers: [
        { name: 'postbox', status: 'connected', source: 'dynamic' },
        { name: 'search', status: 'needs-auth', source: 'user' },
        { name: 'claude.ai Google Drive', status: 'connected', source: 'claudeai' },
      ],
    },
  });

  page = await launch({ port: CHROME_PORT });
  await page.size(1280, 900);
  await page.goto(`${app.origin}/`);
  await page.waitFor(`!!document.querySelector('.app')`, { label: 'the app' });

  const press = async (key, code, vk) => {
    for (const type of ['keyDown', 'keyUp'])
      await page.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode: vk,
        ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}),
      });
    await sleep(150);
  };
  /** The MCP list as the page shows it: each server’s name, status line and checkbox state. */
  const servers = () =>
    page.evaluate(`[...document.querySelectorAll('.dialog [data-server]')].map((el) => ({
      name: el.dataset.server, checked: el.getAttribute('aria-checked'), role: el.getAttribute('role'), tab: el.tabIndex,
      status: el.querySelector('.small')?.textContent.trim() ?? '', visible: el.getBoundingClientRect().width > 0 }))`);
  const legend = () =>
    page.evaluate(`[...document.querySelectorAll('.dialog legend')].find((l) => l.textContent === 'MCP servers')?.parentElement.textContent ?? null`);
  const close = async () => {
    await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(300);
  };

  // The persona editor lists the servers found and the ones the last init reported, each on by default.
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', ${JSON.stringify(persona.id)}))`);
  await page.waitFor(`document.querySelectorAll('.dialog [data-server]').length >= 3`, { label: 'the MCP list' });
  let list = await servers();
  check(
    JSON.stringify(list.map((s) => s.name)) === JSON.stringify(['search', 'docs', 'claude.ai Google Drive']),
    'the editor lists your user and project servers and the claude.ai connector, not Postbox’s own',
    JSON.stringify(list.map((s) => s.name)),
  );
  check(
    list.every((s) => s.visible && s.role === 'checkbox' && s.checked === 'true' && s.tab === 0),
    'each is a visible checkbox, on by default, reachable by Tab',
    JSON.stringify(list),
  );
  const byName = Object.fromEntries(list.map((s) => [s.name, s.status]));
  check(byName.search === 'Needs sign-in · your settings', 'a server’s status comes from the last init', byName.search);
  check(byName.docs === 'Not started yet · this project', 'a server no turn has started yet says so', byName.docs);
  check(byName['claude.ai Google Drive'] === 'Connected · claude.ai connector', 'a connector says it’s connected', byName['claude.ai Google Drive']);
  const text = await page.evaluate(`document.body.textContent`);
  check(!/secret-token|search-server/.test(text), 'no server config reaches the page');

  // Space turns one off; Save stores it on the persona.
  await page.evaluate(`document.querySelector('.dialog [data-server="claude.ai Google Drive"]').focus()`);
  await press(' ', 'Space', 32);
  list = await servers();
  check(list.find((s) => s.name === 'claude.ai Google Drive')?.checked === 'false', 'Space turns a server off');
  await page.evaluate(`[...document.querySelectorAll('.dialog button')].find((b) => b.textContent.trim() === 'Save').click()`);
  for (let i = 0; i < 40 && !app.store.state.personas[persona.id].mcpOff?.length; i++) await sleep(100);
  check(
    JSON.stringify(app.store.state.personas[persona.id].mcpOff) === JSON.stringify(['claude.ai Google Drive']),
    'Save stores the server turned off',
    JSON.stringify(app.store.state.personas[persona.id].mcpOff),
  );
  await close();

  // Reopened, it’s still off; Isolated says only Postbox’s server loads.
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', ${JSON.stringify(persona.id)}))`);
  await page.waitFor(`document.querySelectorAll('.dialog [data-server]').length >= 3`, { label: 'the MCP list again' });
  list = await servers();
  check(list.find((s) => s.name === 'claude.ai Google Drive')?.checked === 'false', 'reopened, the server is still off');
  await page.evaluate(`document.getElementById('pe-setup').focus()`);
  await press(' ', 'Space', 32);
  check(
    (await servers()).length === 0 && /isolated, so only Postbox’s own server loads/.test((await legend()) ?? ''),
    'Isolated: the list gives way to a line saying only Postbox’s server loads',
    await legend(),
  );
  check((await page.evaluate('document.activeElement?.id')) === 'pe-setup', 'focus stays on the setup checkbox');
  await close();

  // The new-agent sheet lists them too, all on.
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openNewAgent({ projectId: ${JSON.stringify(projectId)} }))`);
  await page.waitFor(`document.querySelectorAll('.dialog [data-server]').length >= 2`, { label: 'the new-agent MCP list' });
  list = await servers();
  check(
    list.some((s) => s.name === 'search') && list.some((s) => s.name === 'claude.ai Google Drive') && list.every((s) => s.checked === 'true'),
    'the new-agent sheet lists your servers, all on',
    JSON.stringify(list),
  );
  await close();
} catch (e) {
  check(false, 'the check ran to the end', e.message);
} finally {
  await page?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
