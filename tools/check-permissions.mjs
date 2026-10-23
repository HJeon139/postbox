// A headless Chrome check of permissions (#66, #10, #74), driven with real clicks and key presses:
// - each answer on a permission card (Always allow with its rule shown first, Edit, Don’t allow with a reason, a
//   subagent’s prompt named) reaches the waiting tool call;
// - the panel opens from the conversation’s ⋯ and from the persona editor, and shows the mode, the rules with their
//   sources, the folders, the MCP servers and the effective view; adding a rule and changing the mode work;
// - a write without the page’s token gets 403.
//
//   node tools/check-permissions.mjs
//
// It starts its own Postbox on a fresh data folder in the temp directory, with a scripted Claude Code agent (no real
// turns) working in a temp folder, and a fake home folder for user settings. PB_PORT and PB_CHROME_PORT move it
// (4435 and 9635 by default), so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4435, 9635);

process.env.POSTBOX_BACKENDS = 'mock';
const root = await mkdtemp(join(tmpdir(), 'pb-check-perm-'));
const work = join(root, 'work');
const home = join(root, 'home');
await mkdir(join(work, '.claude'), { recursive: true });
await mkdir(join(home, '.claude'), { recursive: true });
await mkdir(join(work, 'data'));
// One rule in each settings file, so the panel has a source of each kind to show.
await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git status)'] } }));
await writeFile(join(work, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
await writeFile(join(work, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } }));

const app = await start({ port: PORT, dataDir: join(root, 'data'), fresh: true, demo: true, quiet: true, claudeHome: home });
const { rt, store } = app;

// A Claude Code agent whose turns this check scripts: it asks permission, the way the CLI’s prompt tool does.
const answers = [];
const script = [];
rt.adapters.register({
  name: 'claude-code',
  async folderFor() {
    return work;
  },
  async deliver(_session, _message, ctx) {
    const step = script.shift();
    if (step) await step(ctx);
    ctx.text('Done.');
  },
});
store.emit('project', { id: 'pr_check', name: 'Check', folder: work });
const persona = rt.createPersona({ handle: 'coder', backend: 'claude-code', permissionMode: 'ask', tools: ['shell'] });
const thread = rt.createThread({ projectId: 'pr_check', title: 'Permissions check', personaIds: [persona.id] });

const page = await launch({ port: CHROME_PORT });

// ── Real input ──────────────────────────────────────────────────────────────────────────

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
};
const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
async function press(key) {
  const k = KEYS[key];
  const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await settle();
}
/** Types into the focused element, as a keyboard does. */
async function type(text) {
  await page.send('Input.insertText', { text });
  await settle();
}
async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  assert.ok(r, `Nothing to click: ${expr}`);
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type: t, x: r.x, y: r.y, button: t === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((n) => n.textContent.includes(${JSON.stringify(text)}))`;
/** Clicks a menu item once the menu has opened: in a long run Chrome can be slow to paint it. */
async function openMenuItem(label) {
  await page.waitFor(`!!${byText('.menu button.mi', label)}`, { label: `the menu item “${label}”` });
  await click(byText('.menu button.mi', label));
}
// innerText, as a reader sees it: a flex row’s items are separate words.
const text = (expr) => page.evaluate(`(${expr})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);
const focused = () => page.evaluate(`document.activeElement?.id || document.activeElement?.textContent.trim().slice(0, 40) || ''`);
// A time budget, not a count of tries: with other checks running beside it, 100 tries of 50 ms ran out (#162).
const until = async (fn, label, timeout = 15000) => {
  for (const end = Date.now() + timeout; Date.now() < end; ) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

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
  for (let i = 0; i < 4 && (await page.evaluate(`!!document.querySelector('.backdrop, .menu')`)); i++) await press('Escape');
  // Escape hides a headless page (Chrome’s, on macOS, whatever the page does), which slows its timers to a second;
  // bring it back, so each case runs at speed.
  await page.send('Page.bringToFront');
}

await page.size(1280, 900);
await page.goto(`${app.origin}/#/t/${thread.id}`);
await page.waitFor(`!!document.getElementById('composer-input')`, { label: 'the composer' });

// ── Cards ───────────────────────────────────────────────────────────────────────────────

const card = (summary) => byText('.transcript .block', summary);
/** Starts a turn whose agent asks once, and waits for the card. */
async function asking(req) {
  script.push(async (ctx) => {
    answers.push(await ctx.askPermission(req));
  });
  rt.sendMessage(thread.id, { text: `Please ${req.summary}.` });
  await page.waitFor(`!!(${card(req.summary)})?.querySelector('.block-foot')`, { label: `the card to ${req.summary}` });
}
const answered = async (n) => {
  await until(() => answers.length >= n && rt.turns.size === 0, 'the answer to reach the agent');
  return answers[n - 1];
};

await check('#66 Always allow shows the rule and where it’s saved before you click, and returns the suggestions', async () => {
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'make test:*' }], behavior: 'allow', destination: 'session' }];
  await asking({ tool: 'Bash', summary: 'run the tests', detail: 'make test', input: { command: 'make test' }, suggestions });
  const words = await text(`${card('run the tests')}.querySelector('.perm-always')`);
  assert.match(words, /Always allow Bash\(make test:\*\) in this folder \(\.claude\/settings\.local\.json\)/);
  assert.match(words, /session only.*local settings instead/);
  await click(byText('.transcript .block-foot button', 'Always allow'));
  const a = await answered(1);
  assert.equal(a.allow, true);
  assert.deepEqual(a.updatedPermissions[0].destination, 'localSettings');
  assert.match(await text(card('run the tests')), /Always allowed \(Bash\(make test:\*\)\)/);
  assert.equal(await focused(), 'composer-input', 'focus goes back to the composer');
});

await check('#66 without suggestions (as the CLI asks), Always allow saves Postbox’s rule in the folder’s local settings', async () => {
  await asking({ tool: 'Bash', summary: 'run the linter', detail: 'npm run lint', input: { command: 'npm run lint' } });
  assert.match(await text(`${card('run the linter')}.querySelector('.perm-always')`), /Always allow Bash\(npm run:\*\) in this folder/);
  await click(byText('.transcript .block-foot button', 'Always allow'));
  assert.deepEqual(await answered(2), { allow: true });
  const local = JSON.parse(await readFile(join(work, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(local.permissions.allow.includes('Bash(npm run:*)'), JSON.stringify(local));
});

await check('#10 Edit changes the command by keyboard, and the changed command is what runs', async () => {
  await asking({ tool: 'Bash', summary: 'clean the build', detail: 'rm -rf build', input: { command: 'rm -rf build' } });
  await click(byText('.transcript .block-foot button', 'Edit…'));
  assert.match(await focused(), /-edit$/, 'focus moves to the command');
  await page.evaluate(`document.activeElement.select()`);
  await type('rm -rf build/tmp');
  await click(byText('.transcript .perm-form button', 'Allow with this edit'));
  const a = await answered(3);
  assert.deepEqual(a, { allow: true, updatedInput: { command: 'rm -rf build/tmp' } });
  assert.match(await text(card('clean the build')), /Allowed with your edit.*rm -rf build\/tmp/);
});

await check('#10 Edit of a JSON input that doesn’t parse says so, and nothing is sent', async () => {
  await asking({ tool: 'WebFetch', summary: 'fetch the docs', detail: 'https://a.example/', input: { url: 'https://a.example/', prompt: 'p' } });
  await click(byText('.transcript .block-foot button', 'Edit…'));
  await page.evaluate(`document.activeElement.select()`);
  await type('{ "url": ');
  await click(byText('.transcript .perm-form button', 'Allow with this edit'));
  assert.match(await text(`${card('fetch the docs')}.querySelector('.perm-form .err')`), /doesn’t parse/);
  assert.equal(answers.length, 3);
  await page.evaluate(`document.activeElement.select()`);
  await type('{ "url": "https://b.example/", "prompt": "p" }');
  await click(byText('.transcript .perm-form button', 'Allow with this edit'));
  assert.deepEqual((await answered(4)).updatedInput, { url: 'https://b.example/', prompt: 'p' });
});

await check('#10 Don’t allow takes a reason by keyboard, and the agent reads it', async () => {
  await asking({ tool: 'Bash', summary: 'push to main', detail: 'git push origin main', input: { command: 'git push origin main' } });
  await click(byText('.transcript .block-foot button', 'Don’t allow…'));
  assert.match(await focused(), /-why$/);
  await type('Open a pull request instead.');
  await press('Enter');
  const a = await answered(5);
  assert.deepEqual(a, { allow: false, message: 'The person didn’t allow this. Their reason: Open a pull request instead.' });
  assert.match(await text(card('push to main')), /Your reason: Open a pull request instead\./);
});

await check('#66 a subagent’s prompt names the subagent', async () => {
  script.push(async (ctx) => {
    ctx.subagentNames(({ toolUseId }) => (toolUseId === 'toolu_sub' ? 'Explore' : null));
    answers.push(await ctx.askPermission({ tool: 'Bash', summary: 'list the files', detail: 'ls', input: { command: 'ls' }, toolUseId: 'toolu_sub' }));
  });
  rt.sendMessage(thread.id, { text: 'Look around.' });
  await page.waitFor(`!!(${card('list the files')})?.querySelector('.block-foot')`, { label: 'the subagent’s card' });
  assert.match(await text(`${card('list the files')}.querySelector('.title')`), /Let @coder’s subagent \(Explore\) list the files\?/);
  await click(byText('.transcript .block-foot button', 'Allow'));
  assert.equal((await answered(6)).allow, true);
});

// ── The panel ───────────────────────────────────────────────────────────────────────────

const dialog = q('.dialog');
await check('#66 the panel opens from ⋯ › Permissions… with the mode, rules with sources, folders, MCP servers and the effective view', async () => {
  await click(q('header.topbar button[aria-label^="Actions for"]'));
  await openMenuItem('Permissions…');
  await page.waitFor(`!!document.querySelector('.dialog .perm-panel #perm-call')`, { label: 'the panel' });
  const all = await text(dialog);
  assert.match(all, /@coder’s permissions/);
  assert.match(await text(`${dialog}.querySelector('[role="radiogroup"][aria-label="Mode"] [aria-checked="true"]')`), /Ask me/);
  assert.match(all, /Bash\(rm:\*\) from the project’s shared settings/);
  assert.match(all, /Bash\(git status\) from your user settings/);
  assert.match(all, /Bash\(npm test:\*\) from this folder’s local settings/);
  assert.match(all, /WebFetch, WebSearch, Monitor from the persona’s Tools: web\.fetch is unticked/);
  assert.match(all, /Folders.*Where it works/i);
  assert.match(all, /MCP servers/i);
  // The effective view, as you type.
  await click(q('#perm-call'));
  await type('Bash(rm -rf build)');
  assert.match(await text(q('.perm-verdict')), /Refused by the deny rule Bash\(rm:\*\) from the project’s shared settings/);
  await page.evaluate(`document.getElementById('perm-call').select()`);
  await type('Bash(npm test -- --ci)');
  assert.match(await text(q('.perm-verdict')), /Runs: the allow rule Bash\(npm test:\*\) from this folder’s local settings/);
  await page.evaluate(`document.getElementById('perm-call').select()`);
  await type('WebFetch(https://example.com/x)');
  assert.match(await text(q('.perm-verdict')), /Refused by the deny rule WebFetch from the persona’s Tools/);
  await page.evaluate(`document.getElementById('perm-call').select()`);
  await type('Bash(make)');
  assert.match(await text(q('.perm-verdict')), /No rule covers it, so Ask me mode decides: @coder asks you/);
  assert.match(all, /Claude Code has the final say/);
});

await check('#66 a rule added in the panel is saved where you chose, and shows with its source', async () => {
  await click(q('header.topbar button[aria-label^="Actions for"]'));
  await openMenuItem('Permissions…');
  await page.waitFor(`!!document.querySelector('.dialog #perm-p')`, { label: 'the add-rule form' });
  // The default is this folder’s local settings, where the CLI saves “don’t ask again”.
  assert.equal(await page.evaluate(`document.getElementById('perm-w').value`), 'local');
  await click(q('#perm-p'));
  await type('make:*');
  assert.equal(await text(q('.perm-add code.perm-rule')), 'Bash(make:*)');
  await click(byText('.perm-add button', 'Add rule'));
  await page.waitFor(`/Bash\\(make:\\*\\)\\s*from this folder’s local settings/.test(document.querySelector('.dialog')?.innerText)`, {
    label: 'the local rule',
  });
  const local = JSON.parse(await readFile(join(work, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(local.permissions.allow.includes('Bash(make:*)'));
  // This conversation only, on request.
  await page.evaluate(`(() => { const s = document.getElementById('perm-w'); s.value = 'conversation'; s.dispatchEvent(new Event('change')); })()`);
  await click(q('#perm-p'));
  await type('npx prettier:*');
  await click(byText('.perm-add button', 'Add rule'));
  await page.waitFor(`/Bash\\(npx prettier:\\*\\)\\s*from this conversation/.test(document.querySelector('.dialog')?.innerText)`, { label: 'the new rule' });
  const se = rt.sessionsIn(thread.id)[0];
  assert.deepEqual(store.state.sessions[se.id].rules.allow, ['Bash(npx prettier:*)']);
  // The project’s shared file has no Remove; a local one does.
  assert.ok(await page.evaluate(`!${byText('.dialog .list-rows li', 'Bash(rm:*)')}.querySelector('button')`));
  assert.ok(await page.evaluate(`!!${byText('.dialog .list-rows li', 'Bash(make:*)')}.querySelector('button[aria-label^="Remove"]')`));
});

await check('#66 the mode changes from the panel, and says it applies from the next turn', async () => {
  await click(q('header.topbar button[aria-label^="Actions for"]'));
  await openMenuItem('Permissions…');
  await page.waitFor(`!!document.querySelector('.dialog [aria-label="Mode"]')`, { label: 'the mode' });
  await click(byText('.dialog [aria-label="Mode"] button', 'Accept edits'));
  await page.waitFor(`!!document.querySelector('.dialog .perm-status')`, { label: 'the status line' });
  assert.match(await text(q('.dialog .perm-status')), /@coder is in Accept edits mode from its next turn/);
  assert.equal(store.state.personas[persona.id].permissionMode, 'acceptEdits');
});

await check('#66 a folder added from the panel’s folder picker is listed for this conversation', async () => {
  await click(q('header.topbar button[aria-label^="Actions for"]'));
  await openMenuItem('Permissions…');
  await page.waitFor(`!!${byText('.dialog button', 'Add folder…')}`, { label: 'Add folder' });
  await click(byText('.dialog button', 'Add folder…'));
  await page.waitFor(`!![...document.querySelectorAll('.dialog button')].find((b) => b.getAttribute('aria-label') === 'Add data')`, {
    label: 'the data folder',
  });
  await click(`[...document.querySelectorAll('.dialog button')].find((b) => b.getAttribute('aria-label') === 'Add data')`);
  await page.waitFor(`/From this conversation/.test(document.querySelector('.dialog')?.textContent ?? '')`, { label: 'the added folder' });
  const se = rt.sessionsIn(thread.id)[0];
  assert.deepEqual(store.state.sessions[se.id].addDirs, [join(work, 'data')]);
  // Escape closes only the panel the picker was opened over, not both at once.
  assert.equal(await page.evaluate(`document.querySelectorAll('.backdrop').length`), 1);
});

await check('#66 the persona editor opens the same panel', async () => {
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', ${JSON.stringify(persona.id)}))`);
  await page.waitFor(`!!document.getElementById('pe-perms')`, { label: 'the persona editor’s Permissions…' });
  await click(q('#pe-perms'));
  await page.waitFor(
    `document.querySelectorAll('.backdrop').length === 2 && !![...document.querySelectorAll('.backdrop')].at(-1).querySelector('.perm-panel #perm-call')`,
    {
      label: 'the panel over the editor',
    },
  );
  assert.match(await text(`[...document.querySelectorAll('.backdrop')].at(-1).querySelector('.d-head')`), /@coder’s permissions/);
  await press('Escape');
  assert.equal(await page.evaluate(`document.querySelectorAll('.backdrop').length`), 1, 'Escape closes the panel and keeps the editor');
});

// ── #74 ─────────────────────────────────────────────────────────────────────────────────

await check('#74 a write without the page’s token gets 403; the page’s own writes go through', async () => {
  const r = await fetch(`${app.origin}/api/permissions/rules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ personaId: persona.id, behavior: 'allow', rule: 'Bash' }),
  });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /came from outside the Postbox page/);
  const inPage = await page.evaluate(
    `fetch('/api/threads/${thread.id}/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status)`,
  );
  assert.equal(inPage, 200);
  // Loading / without a browser’s headers gets the page, not the token.
  const bare = await fetch(`${app.origin}/`);
  await bare.arrayBuffer();
  assert.equal(bare.headers.get('set-cookie'), null);
});

await check('#74 a page whose token is gone (as after a restart) gets a new one by fetching /, and the write goes through', async () => {
  await page.send('Network.clearBrowserCookies');
  const r = await page.evaluate(`import('/app/js/client.mjs').then((m) => m.api('/api/threads/${thread.id}/view', {})).then(() => 'ok', (e) => e.message)`);
  assert.equal(r, 'ok', 'the browser’s same-origin fetch of / carries Sec-Fetch-Site: same-origin, so it gets the token');
});

await check('#66 the panel fits a narrow window (375 px) without scrolling sideways', async () => {
  await page.size(375, 800);
  // The top bar fits its chips to the new width after a resize, which redraws it: wait for that before opening its menu.
  await new Promise((r) => setTimeout(r, 800));
  await settle();
  await click(q('header.topbar button[aria-label^="Actions for"]'));
  await openMenuItem('Permissions…');
  await page.waitFor(`!!document.querySelector('.dialog .perm-panel #perm-call')`, { label: 'the panel' });
  const over = await page.evaluate(
    `(() => { const d = document.querySelector('.dialog'); return [d.scrollWidth - d.clientWidth, document.documentElement.scrollWidth - innerWidth]; })()`,
  );
  assert.deepEqual(over, [0, 0], 'nothing overflows sideways');
  await page.size(1280, 900);
});

const errors = page.logs.filter((l) => l.startsWith('exception'));
record(!errors.length, 'the page threw no exceptions', errors.join('\n'));
await page.close();
await app.close();
await rm(root, { recursive: true, force: true });
finish();
