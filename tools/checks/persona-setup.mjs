// Checks the persona sheet’s setup controls (#57) in headless Chrome: “Uses your Claude Code setup” (on by
// default) and “Can publish outside Postbox” (off by default) appear for a real backend, with help text, work
// from the keyboard, and save to the persona. Also checks the new-agent sheet’s defaults.
//
//   node tools/checks/persona-setup.mjs
//
// It starts its own fresh Postbox (demo mode, with a stand-in Claude Code backend so the real backend’s fields
// show) and Chrome. PB_PORT and PB_CHROME_PORT move them (4400 and 9600 by default), so sessions working in
// parallel don’t collide. It reports through tools/harness.mjs: one line per assertion, and exit code 1 on any failure.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGY_CAPABILITIES } from '../../server/adapters/antigravity-cli.mjs';
import { start } from '../../server/index.mjs';
import { js, launch, sleep } from '../cdp.mjs';
import { record as check, finish, ports } from '../harness.mjs';

const { PORT, CHROME_PORT } = await ports(4400, 9600);
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-setup-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
/** @type {any} */
let page = null;
try {
  // A stand-in for the Claude Code backend: it never runs a turn here, it only makes the real fields show.
  app.rt.adapters.register({ name: 'claude-code', deliver: async () => {} });
  app.rt.adapters.register({
    name: 'antigravity-cli',
    capabilities: { ...AGY_CAPABILITIES, models: ['gemini-2.5-pro', 'gemini-3.8-flash-high'] },
    deliver: async () => {},
  });
  const persona = app.rt.createPersona({ handle: 'checker', backend: 'claude-code' });
  check(persona.usesHostSetup === true && persona.canPublish === false, 'a new persona uses your setup and can’t publish');

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
  /** What the page shows for a setup checkbox: its state, name, help, and whether it’s visible and focusable. */
  const read = (id) =>
    page.evaluate(`(() => {
      const el = document.getElementById(${js(id)});
      if (!el) return null;
      const help = document.getElementById(el.getAttribute('aria-describedby'));
      const r = el.getBoundingClientRect();
      return { checked: el.getAttribute('aria-checked'), role: el.getAttribute('role'), name: el.textContent.trim(), tab: el.tabIndex,
        help: help?.textContent.trim() ?? '', visible: r.width > 0 && r.height > 0 && help?.offsetParent !== null };
    })()`);

  // The persona editor.
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', ${js(persona.id)}))`);
  await page.waitFor(`!!document.getElementById('pe-setup')`, { label: 'the persona editor' });
  const setup = await read('pe-setup');
  const publish = await read('pe-publish');
  check(
    setup?.visible && setup.role === 'checkbox' && setup.name === 'Uses your Claude Code setup',
    'the editor shows “Uses your Claude Code setup”',
    JSON.stringify(setup),
  );
  check(setup?.checked === 'true', '“Uses your Claude Code setup” is on by default', setup?.checked);
  check(/skills, commands, plugins and permission rules/.test(setup?.help ?? ''), 'it has help text', setup?.help);
  check(/folder’s local file, where Always allow saves/.test(setup?.help ?? ''), 'its help says Isolated keeps the folder’s local file', setup?.help);
  check(
    publish?.visible && publish.role === 'checkbox' && publish.name === 'Can publish outside Postbox',
    'the editor shows “Can publish outside Postbox”',
    JSON.stringify(publish),
  );
  check(publish?.checked === 'false', '“Can publish outside Postbox” is off by default', publish?.checked);
  check(/artifacts, and connectors that post or send/.test(publish?.help ?? ''), 'it has help text', publish?.help);

  // Keyboard: Tab moves from one to the other; Space and Enter toggle.
  await page.evaluate(`document.getElementById('pe-setup').focus()`);
  await press(' ', 'Space', 32);
  check((await read('pe-setup'))?.checked === 'false', 'Space turns “Uses your Claude Code setup” off');
  await press('Tab', 'Tab', 9);
  check((await page.evaluate('document.activeElement?.id')) === 'pe-publish', 'Tab reaches “Can publish outside Postbox”');
  await press('Enter', 'Enter', 13);
  check((await read('pe-publish'))?.checked === 'true', 'Enter turns “Can publish outside Postbox” on');

  // Save, and the persona has them.
  await page.evaluate(`[...document.querySelectorAll('.dialog button')].find((b) => b.textContent.trim() === 'Save').click()`);
  for (let i = 0; i < 40 && app.store.state.personas[persona.id].canPublish !== true; i++) await sleep(100);
  const saved = app.store.state.personas[persona.id];
  check(
    saved.usesHostSetup === false && saved.canPublish === true,
    'Save stores both on the persona',
    JSON.stringify({ usesHostSetup: saved.usesHostSetup, canPublish: saved.canPublish }),
  );

  // The new-agent sheet, on the real backend it picks by default.
  await page.evaluate(
    `document.querySelector('.dialog [aria-label="Close"]')?.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`,
  );
  await sleep(300);
  const projectId = Object.keys(app.store.state.projects)[0];
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openNewAgent({ projectId: ${js(projectId)} }))`);
  await page.waitFor(`!!document.getElementById('na-setup')`, { label: 'the new-agent sheet' });
  const na = [await read('na-setup'), await read('na-publish')];
  check(
    na[0]?.visible && na[0].checked === 'true' && na[1]?.visible && na[1].checked === 'false',
    'the new-agent sheet shows both, with the defaults',
    JSON.stringify(na),
  );

  // Picking the Gemini boilerplate switches to the Antigravity CLI, its preferred Gemini model and its prompt; Critic restores Claude Code.
  await page.evaluate(`[...document.querySelectorAll('.dialog [role=radio]')].find((b) => b.textContent.trim() === 'Gemini').click()`);
  const gem = await page.evaluate(
    `({ b: document.getElementById('na-b')?.value, m: document.getElementById('na-m')?.value, i: document.getElementById('na-i')?.value })`,
  );
  check(
    gem.b === 'antigravity-cli' && gem.m === 'gemini-3.8-flash-high' && /^# Gemini\n/.test(gem.i ?? ''),
    'the Gemini boilerplate selects the Antigravity CLI, its preferred Gemini model and its prompt',
    JSON.stringify(gem),
  );
  await page.evaluate(`[...document.querySelectorAll('.dialog [role=radio]')].find((b) => b.textContent.trim() === 'Critic').click()`);
  const back = await page.evaluate(`({ b: document.getElementById('na-b')?.value, m: document.getElementById('na-m')?.value })`);
  check(back.b === 'claude-code' && back.m === 'claude-opus-5-5', 'picking Critic restores the default backend and model', JSON.stringify(back));
} catch (e) {
  check(false, 'the check ran to the end', e.message);
} finally {
  await page?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
finish();
