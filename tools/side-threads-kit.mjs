// What tools/check-side-threads.mjs drives the page with: its own server with the demo seed on a fresh data folder,
// @indexer and @researcher on a fake Claude Code backend that holds each turn open until the check lets it go or Stop
// aborts it, a room with both, and the keyboard, waiting and opening the check uses.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { js, launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

export const { PORT, CHROME_PORT } = await ports(4890, 10090);

process.env.POSTBOX_BACKENDS = 'mock';
export const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-side-'));
export const claudeHome = await mkdtemp(join(tmpdir(), 'pb-check-side-home-'));
export const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true, claudeHome });
export const page = await launch({ port: CHROME_PORT });
export const { rt, store } = app;

// ── A backend that holds its turns ──────────────────────────────────────────────────────

/** Every turn the fake was sent: who, where, and what came with it. */
export const turns = [];
/** What the next turn of a session does, by session id; otherwise it holds until released or stopped. */
export const scripts = new Map();
export const releases = new Map();
rt.adapters.register({
  name: 'claude-code',
  async folderFor() {
    return dataDir;
  },
  fork() {},
  async deliver(session, message, ctx) {
    turns.push({ sessionId: session.id, thread: ctx.thread.id, text: message.text ?? '', context: message.context ?? [] });
    const script = scripts.get(session.id);
    scripts.delete(session.id);
    if (script) return script(ctx);
    ctx.status({ state: 'tool', currentStep: 'Reading the shelf' });
    await new Promise((r) => {
      releases.set(session.id, r);
      ctx.signal.addEventListener('abort', r);
    });
    if (!ctx.signal.aborted) ctx.text('Done.');
  },
});
export const release = (id) => releases.get(id)?.();

export const personaNamed = (handle) => Object.values(store.state.personas).find((p) => p.handle === handle);
for (const handle of ['indexer', 'researcher'])
  store.emit('persona', { ...personaNamed(handle), backend: 'claude-code', model: 'claude-opus-5-5', version: (personaNamed(handle).version ?? 1) + 1 });
export const room = rt.createThread({
  projectId: Object.keys(store.state.projects)[0],
  title: 'Side checks',
  personaIds: [personaNamed('indexer').id, personaNamed('researcher').id],
});
export const sessionIn = (t, handle) => rt.sessionsIn(t.id).find((x) => x.handle === handle);
export const indexer = sessionIn(room, 'indexer');
export const researcher = sessionIn(room, 'researcher');
export const sideOf = () => Object.values(store.state.threads).find((t) => t.kind === 'side' && t.parentId === room.id);
export const busy = (id) => ['think', 'gen', 'tool', 'needs'].includes(store.state.sessions[id]?.state);
/** An agent wakes another as if the person had just written: the wake limit (#108) isn’t what this checks. */
export const wake = (from, handle, text) => {
  rt.putThread({ ...store.state.threads[room.id], hops: 0 });
  return rt.agentWake(from, handle, text);
};

// ── Driving the page ────────────────────────────────────────────────────────────────────

export const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  j: { code: 'KeyJ', keyCode: 74 },
};
/** Presses a key the way a keyboard does. ctrl: with Control held, as ⌃J is. */
export async function press(key, { ctrl = false } = {}) {
  const k = KEYS[key];
  const text = ctrl ? undefined : k.text;
  const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: ctrl ? 2 : 0 };
  await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await settle();
}
/** Types into the focused field, as a keyboard’s text input does. */
export async function type(text) {
  await page.send('Input.insertText', { text });
  await settle();
}
export const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
export async function until(test, label) {
  for (let i = 0; i < 50; i++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
export const q = (sel) => `document.querySelector(${js(sel)})`;
/** An agent’s row in the sidebar, the li around its button. */
export const row = (handle) => `[...document.querySelectorAll('.rail .agent-row')].find((r) => r.querySelector('.agent-btn b')?.textContent === '@${handle}')`;
export const subs = (handle) =>
  page.evaluate(`[...(${row(handle)}?.querySelectorAll('.agent-sub') ?? [])].map((n) => n.innerText.replace(/\\s+/g, ' ').trim())`);
export const sideLine = () =>
  page.evaluate(`[...document.querySelectorAll('#main .pill')].find((p) => p.textContent.includes('asked'))?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);

export async function check(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
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
}
export let loaded = false;
export async function open(hash) {
  if (loaded) {
    // What the check changed on the server must have reached the page first, or it shows what was there before.
    await page.synced(store.state.seq);
    await page.evaluate(`location.hash = ${js(hash)}`);
  } else await page.goto(`${app.origin}/${hash}`);
  loaded = true;
  await page.waitFor(`document.querySelector('header.topbar')`);
  await settle();
}

/** The check’s last step: close the page and the server, remove their folders, and report. */
export async function done() {
  await page.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(claudeHome, { recursive: true, force: true });
  record(!page.logs.length, 'the page logged no errors', page.logs.join('\n'));
  finish();
}
