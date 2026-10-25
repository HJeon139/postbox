// A headless Chrome check of what the persona sheet says an agent runs with: your MCP servers, each with its
// status and a checkbox that’s on by default (#59), and that saving stores the ones turned off; the Tools
// checklist’s real-backend id and what ticking means there (#5); and the effort field next to the model, which
// saving stores (#60).
//
//   node tools/check-runtime.mjs
//
// It starts its own Postbox on a fresh temp data folder (demo mode, with a stand-in Claude Code backend so the
// real backend’s fields show) and Chrome. The person’s Claude Code config comes from a fake home folder in the
// temp directory (start()’s claudeHome), so it never reads the real one. PB_PORT and PB_CHROME_PORT move them
// (4410 and 9610 by default). It reports through tools/harness.mjs: one line per assertion, and exit code 1 on any failure.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { js, launch, sleep } from './cdp.mjs';
import { record as check, finish, ports } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4410, 9610);
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
  /** The effort field: its label, value, options, help, and the label of the field before it. */
  const effortField = (idp) =>
    page.evaluate(`(() => {
      const el = document.getElementById('${idp}-e');
      if (!el) return null;
      const field = el.closest('.field');
      const label = document.querySelector('label[for="${idp}-e"]')?.textContent;
      return { label, value: el.value, options: [...el.options].map((o) => o.textContent),
        help: document.getElementById(el.getAttribute('aria-describedby'))?.textContent ?? '',
        after: field.previousElementSibling?.querySelector('.label')?.textContent ?? null, visible: el.getBoundingClientRect().width > 0 };
    })()`);
  const close = async () => {
    await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(300);
  };

  // The persona editor lists the servers found and the ones the last init reported, each on by default.
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', ${js(persona.id)}))`);
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

  // #60: Effort sits next to Model, with Claude Code’s default; pick High.
  const effort = await effortField('pe');
  check(
    effort?.label === 'Effort' && effort.value === 'medium' && effort.after === 'Model' && effort.visible,
    'the editor shows Effort right after Model, at Medium by default',
    JSON.stringify(effort),
  );
  check(
    JSON.stringify(effort?.options) === JSON.stringify(['Low', 'Medium', 'High', 'Extra high', 'Max']),
    'it offers every level Claude Code takes',
    JSON.stringify(effort?.options),
  );
  check(/How much it thinks before it answers/.test(effort?.help ?? ''), 'it has help text', effort?.help);
  await page.evaluate(
    `(() => { const s = document.getElementById('pe-e'); s.focus(); s.value = 'high'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );

  // Space turns one off; Save stores it on the persona, with the effort.
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
  check(app.store.state.personas[persona.id].effort === 'high', 'Save stores the effort', app.store.state.personas[persona.id].effort);
  await close();

  // Reopened, it’s still off; Isolated says only Postbox’s server loads.
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', ${js(persona.id)}))`);
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
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openNewAgent({ projectId: ${js(projectId)} }))`);
  await page.waitFor(`document.querySelectorAll('.dialog [data-server]').length >= 2`, { label: 'the new-agent MCP list' });
  list = await servers();
  check(
    list.some((s) => s.name === 'search') && list.some((s) => s.name === 'claude.ai Google Drive') && list.every((s) => s.checked === 'true'),
    'the new-agent sheet lists your servers, all on',
    JSON.stringify(list),
  );
  const naEffort = await effortField('na');
  check(naEffort?.value === 'medium' && naEffort.after === 'Model', 'the new-agent sheet has Effort after Model, at Medium', JSON.stringify(naEffort));
  // #5: the checklist offers agents.outside, off by default, and says what a tick means on a real backend.
  const outside = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('.dialog fieldset .check')].find((c) => c.querySelector('.mono')?.textContent === 'agents.outside');
    const help = [...document.querySelectorAll('.dialog fieldset .help')].map((x) => x.textContent).find((x) => x.includes('unticked tool'));
    return el ? { checked: el.getAttribute('aria-checked'), label: el.querySelector('.small')?.textContent, help } : null;
  })()`);
  check(
    outside?.checked === 'false' && outside.label === 'Message, schedule or start agents outside Postbox',
    'the Tools checklist offers agents.outside, off by default',
    JSON.stringify(outside),
  );
  check(/unticked tool is turned off\. A ticked one still follows its permissions/.test(outside?.help ?? ''), 'it says what ticking means', outside?.help);
  await close();

  // A narrow window: the editor, with a long server name, doesn’t scroll sideways.
  app.rt.updateSession(se.id, {
    mcpServers: { at: Date.now(), servers: [{ name: 'plugin:engineering:google calendar and a much longer name', status: 'failed', source: 'plugin' }] },
  });
  await page.size(375, 812);
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', ${js(persona.id)}))`);
  await page.waitFor(`!!document.querySelector('.dialog [data-server^="plugin:"]')`, { label: 'the MCP list at 375 px' });
  // Anything that sticks out past the dialog’s right edge (a field’s own text scrolling inside it is fine).
  const wide = await page.evaluate(`(() => {
    const d = document.querySelector('.dialog').getBoundingClientRect();
    return [...document.querySelectorAll('.dialog *')].filter((el) => el.getBoundingClientRect().right > d.right + 1)
      .map((el) => (el.className || el.tagName) + ': ' + el.textContent.slice(0, 40)).slice(0, 5);
  })()`);
  const overflow = await page.evaluate(`document.documentElement.scrollWidth > window.innerWidth + 1`);
  check(!overflow && !wide.length, 'at 375 px the editor doesn’t scroll sideways', JSON.stringify({ overflow, wide }));
  await close();
} catch (e) {
  check(false, 'the check ran to the end', e.message);
} finally {
  await page?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
finish();
