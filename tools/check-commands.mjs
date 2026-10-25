// A headless Chrome check of commands in the composer (#67), driven with real key presses and clicks:
// - `/` opens the command menu, by typing and with the Commands button; arrows and Enter pick, Escape closes;
// - a Postbox command runs without a turn (/mode, /rename);
// - an agent’s skill, picked in a room with two agents, fills `/name `, shows its argument hint, and runs as that
//   agent’s turn;
// - `!` runs a command in the conversation’s folder and shows its output, exit code and duration; a failing command
//   shows its exit code; Stop stops one; the next turn of an agent reads it, and nothing woke it; in a topic thread,
//   `!` says before sending that it won’t run there (#104);
// - a `!` request without the page’s token gets 403.
//
//   node tools/check-commands.mjs
//
// It starts its own Postbox on a fresh data folder in the temp directory, with scripted Claude Code agents (no real
// turns), and runs real commands through your shell in a temp folder. PB_PORT and PB_CHROME_PORT move it (4437 and
// 9637 by default), so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { js, launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4437, 9637);

process.env.POSTBOX_BACKENDS = 'mock';
const root = await mkdtemp(join(tmpdir(), 'pb-check-cmd-'));
const work = join(root, 'work');
await mkdir(work);
await writeFile(join(work, 'hello.txt'), 'hello from the folder\n');
const app = await start({ port: PORT, dataDir: join(root, 'data'), fresh: true, demo: true, quiet: true, claudeHome: root });
const { rt, store } = app;

// Claude Code agents whose turns this check records: what each was sent, and nothing else.
const turns = [];
rt.adapters.register({
  name: 'claude-code',
  async folderFor() {
    return work;
  },
  async deliver(session, message, ctx) {
    turns.push({ handle: session.handle, message });
    ctx.text('Done.');
  },
});
store.emit('project', { id: 'pr_cmd', name: 'Commands', folder: work });
const alpha = rt.createPersona({ handle: 'alpha', backend: 'claude-code', permissionMode: 'ask' });
const beta = rt.createPersona({ handle: 'beta', backend: 'claude-code', permissionMode: 'ask' });
const room = rt.createThread({ projectId: 'pr_cmd', title: 'Commands check', personaIds: [alpha.id, beta.id] });
const [seA, seB] = rt.sessionsIn(room.id);
// Their skills and commands, as an init or the SDK’s supportedCommands() would give them.
rt.recordCommands(seA.id, [{ name: 'review', description: 'Review a file', argumentHint: '<file>', skill: true }, { name: 'compact' }]);
rt.recordCommands(seB.id, [{ name: 'release-notes', description: 'Draft release notes', argumentHint: '[version]' }]);

const page = await launch({ port: CHROME_PORT });

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
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
/** Types into the focused element, one character at a time, as a keyboard does (each fires input). */
async function type(text) {
  for (const ch of text) await page.send('Input.insertText', { text: ch });
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
const q = (sel) => `document.querySelector(${js(sel)})`;
const byText = (sel, text) => `[...document.querySelectorAll(${js(sel)})].find((n) => n.textContent.includes(${js(text)}))`;
const text = (expr) => page.evaluate(`(${expr})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);
const composer = q('#composer-input');
const clearComposer = () => page.evaluate(`(() => { const t = ${composer}; t.value = ''; t.dispatchEvent(new Event('input')); t.focus(); })()`);
const until = async (fn, label) => {
  for (let i = 0; i < 200; i++) {
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
  for (let i = 0; i < 4 && (await page.evaluate(`!!document.querySelector('.backdrop, .menu:not(.mention-menu)')`)); i++) await press('Escape');
  // Escape hides a headless page (Chrome’s, on macOS), which slows its timers; bring it back.
  await page.send('Page.bringToFront');
  await clearComposer();
}

await page.size(1280, 900);
await page.goto(`${app.origin}/#/t/${room.id}`);
await page.waitFor(`!!${composer}`, { label: 'the composer' });

// ── / ───────────────────────────────────────────────────────────────────────────────────

await check('#67 typing / opens the menu: Postbox’s commands, then each agent’s, grouped; Escape closes it', async () => {
  await clearComposer();
  await type('/');
  await page.waitFor(`!!document.getElementById('slash-list')`, { label: 'the menu' });
  const all = await text(q('#slash-list'));
  assert.match(all, /POSTBOX.*\/permissions.*\/mode.*\/model.*\/effort.*\/add-dir.*\/mcp.*\/compact.*\/stop.*\/rename.*\/archive/i);
  assert.match(all, /@alpha’s skills and commands \/review <file> Review a file/i);
  assert.match(all, /@beta’s skills and commands \/release-notes \[version\] Draft release notes/i);
  // compact is Postbox’s here (it runs /compact as the agent’s turn), so it isn’t listed twice.
  assert.equal((all.match(/\/compact/g) ?? []).length, 1);
  assert.equal(await page.evaluate(`${composer}.getAttribute('aria-activedescendant')`), 'slash-0');
  await press('ArrowDown');
  assert.equal(await page.evaluate(`${composer}.getAttribute('aria-activedescendant')`), 'slash-1');
  await press('Escape');
  assert.equal(await page.evaluate(`!!document.getElementById('slash-list')`), false);
  assert.equal(await page.evaluate(`document.activeElement === ${composer}`), true, 'focus stays in the composer');
});

await check('#67 the Commands button opens the same menu', async () => {
  await click(q('.composer button[aria-label="Commands"]'));
  await page.waitFor(`!!document.getElementById('slash-list')`, { label: 'the menu' });
  assert.equal(await page.evaluate(`${composer}.value`), '/');
  assert.equal(await page.evaluate(`document.activeElement === ${composer}`), true);
});

await check('#67 /mode runs without a turn: the choice changes the agent’s mode and says when it applies', async () => {
  const before = turns.length;
  await type('/mo');
  assert.match(await text(q('#slash-list')), /\/mode/);
  await press('Enter');
  await page.waitFor(`!!document.querySelector('.dialog [aria-label="Permission mode"]')`, { label: 'the mode choice' });
  await click(byText('.dialog [aria-label="Permission mode"] button', 'Accept edits'));
  await page.waitFor(`!!document.querySelector('.dialog .perm-status')`, { label: 'the status' });
  assert.match(await text(q('.dialog .perm-status')), /uses Accept edits, in every conversation, from its next turn/);
  const who = store.state.sessions[store.state.threads[room.id].lastSpeaker ?? seA.id]?.personaId ?? alpha.id;
  assert.equal(store.state.personas[who].permissionMode, 'acceptEdits');
  assert.equal(turns.length, before, 'no turn');
  assert.equal(await page.evaluate(`${composer}.value`), '', 'the composer is cleared');
});

await check('#67 /effort sets this conversation’s effort; /rename opens the rename sheet', async () => {
  await type('/effort');
  await press('Enter');
  await page.waitFor(`!!document.querySelector('.dialog [aria-label="Effort"]')`, { label: 'the effort choice' });
  await click(byText('.dialog [aria-label="Effort"] button', 'High'));
  await page.waitFor(`!!document.querySelector('.dialog .perm-status')`, { label: 'the status' });
  assert.match(await text(q('.dialog .perm-status')), /uses High in this conversation, from its next turn/);
  assert.ok(rt.sessionsIn(room.id).some((se) => store.state.sessions[se.id].personaSnapshot.effort === 'high'));
  await press('Escape');
  await page.send('Page.bringToFront');
  await clearComposer();
  await type('/ren');
  await press('Enter');
  await page.waitFor(`!!document.querySelector('.dialog input')`, { label: 'the rename sheet' });
  assert.match(await text(q('.dialog .d-head')), /Rename/);
});

await check('#67 an agent’s skill: picking it fills /name and its hint, addresses that agent in a room, and runs as its turn', async () => {
  await type('/release');
  await press('Enter');
  assert.equal(await page.evaluate(`${composer}.value`), '/release-notes ');
  assert.match(await text(q('.composer .hint')), /Enter runs \/release-notes \[version\] as @beta’s turn/);
  await type('2.1');
  await press('Enter');
  const turn = await until(() => turns.find((x) => x.message.slash), 'the skill’s turn');
  assert.equal(turn.handle, 'beta');
  assert.equal(turn.message.text, '/release-notes 2.1');
  assert.equal(turn.message.context, undefined, 'the skill is the whole prompt');
  await page.waitFor(`!!${byText('.transcript .me-card', '/release-notes 2.1')}`, { label: 'the line in the transcript' });
});

// ── ! ───────────────────────────────────────────────────────────────────────────────────

const commandCard = (cmd) => byText('.transcript .cmd-block', `! ${cmd}`);
await check('#67 ! runs a command in the conversation’s folder, with its output, exit code and duration', async () => {
  const before = turns.length;
  await type('!cat hello.txt && pwd');
  assert.match(await text(q('.composer .hint')), new RegExp(`Runs in ${work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} as you`));
  await press('Enter');
  await page.waitFor(`/Exit 0/.test(${commandCard('cat hello.txt && pwd')}?.innerText ?? '')`, { label: 'the command to finish' });
  const card = await text(commandCard('cat hello.txt && pwd'));
  assert.match(card, /hello from the folder/);
  assert.match(card, /pb-check-cmd-.*work/);
  assert.match(card, /Exit 0 · \d+\.\d s/);
  assert.equal(turns.length, before, 'running it woke no agent');
});

await check('#67 a failing command shows its exit code', async () => {
  await type('!echo oops >&2; exit 3');
  await press('Enter');
  await page.waitFor(`/Exit 3/.test(${commandCard('echo oops >&2; exit 3')}?.innerText ?? '')`, { label: 'the failing command' });
  assert.match(await text(commandCard('echo oops >&2; exit 3')), /oops/);
  assert.ok(await page.evaluate(`${commandCard('echo oops >&2; exit 3')}.classList.contains('cmd-failed')`));
});

await check('#67 Stop stops a running command', async () => {
  await type('!sleep 30');
  await press('Enter');
  await page.waitFor(`!!${commandCard('sleep 30')}?.querySelector('button')`, { label: 'Stop' });
  await click(`${commandCard('sleep 30')}.querySelector('button')`);
  await page.waitFor(`/Stopped by you/.test(${commandCard('sleep 30')}?.innerText ?? '')`, { label: 'the stopped command' });
});

await check('#67 the next turn reads what ran, with its output', async () => {
  rt.sendMessage(room.id, { text: '@alpha what did that print?' });
  const turn = await until(() => turns.find((x) => x.handle === 'alpha' && x.message.text?.includes('what did that print')), 'alpha’s turn');
  const context = turn.message.context.join('\n');
  assert.match(context, /You ran `cat hello\.txt && pwd` in .* \(it exited with 0\)\. Output:\n```\nhello from the folder/);
  assert.match(context, /You ran `echo oops >&2; exit 3` in .* \(it exited with 3\)/);
});

await check('#104 ! in a topic thread says before sending that it won’t run there, and goes as a message', async () => {
  const root = store.items(room.id).find((i) => i.kind === 'agent');
  const { threadId } = rt.startTopic(room.id, root.id);
  // A thread made a moment ago must have reached the page first, or the page doesn’t know it.
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = '#/t/${room.id}/side/${threadId}'`);
  await page.waitFor(`!!${q('#side-input')}`, { label: 'the topic thread’s composer' });
  await click(q('#side-input'));
  await type('!gh --help');
  const hint = await text(`${q('#side-input')}.closest('.composer').querySelector('.hint')`);
  assert.match(hint, /! runs commands only in the conversation’s own composer\. Here, this goes to the agent as a message\./);
  // Back to a message, the hint is the thread’s own again.
  await page.evaluate(`(() => { const t = ${q('#side-input')}; t.value = 'gh --help'; t.dispatchEvent(new Event('input')); })()`);
  await settle();
  assert.doesNotMatch(await text(`${q('#side-input')}.closest('.composer').querySelector('.hint')`), /runs commands only/);
  assert.equal(store.items(threadId).filter((i) => i.kind === 'command').length, 0, 'nothing ran in the thread');
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = '#/t/${room.id}'`);
  await page.waitFor(`!${q('#side-input')}`, { label: 'the panel to close' });
});

await check('#67 a ! request without the page’s token gets 403, and nothing runs', async () => {
  const count = store.items(room.id).filter((i) => i.kind === 'command').length;
  const r = await fetch(`${app.origin}/api/threads/${room.id}/shell`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'touch pwned' }),
  });
  assert.equal(r.status, 403);
  assert.equal(store.items(room.id).filter((i) => i.kind === 'command').length, count);
});

const errors = page.logs.filter((l) => l.startsWith('exception'));
record(!errors.length, 'the page threw no exceptions', errors.join('\n'));
await page.close();
await app.close();
await rm(root, { recursive: true, force: true });
finish();
