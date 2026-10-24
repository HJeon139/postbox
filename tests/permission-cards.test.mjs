// Permission cards (server/permission-cards.mjs): how long a card waits (#220).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { POSTBOX_TIMEOUT_MS } from '../server/adapters/setup.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const folders = [];
after(() => Promise.all(folders.map((f) => rm(f, { recursive: true, force: true }))));

/** A Claude Code agent whose turns the test scripts, working in a temp folder. */
class ScriptedClaude {
  name = 'claude-code';
  constructor(folder) {
    this.folder = folder;
    this.next = [];
    this.calls = [];
  }
  async folderFor() {
    return this.folder;
  }
  async deliver(_session, message, ctx) {
    this.calls.push({ message, ctx });
    const step = this.next.shift() ?? (async (c) => c.text('ok'));
    await step(ctx);
  }
}

async function setup() {
  const folder = await mkdtemp(join(tmpdir(), 'pb-cards-'));
  folders.push(folder);
  const store = new Store(null);
  const adapter = new ScriptedClaude(folder);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: folder },
  });
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'researcher', backend: 'claude-code', tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  return { store, rt, adapter, t, se: rt.sessionsIn(t.id)[0] };
}
const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(5);
};

// Claude Code drops the call at POSTBOX_TIMEOUT_MS (the MCP server’s timeout, #217), so an answer after it would go
// nowhere. node:test’s mock timers stand in for the clock, so the test doesn’t wait 25 hours.
test('#220 a card nobody answers expires at POSTBOX_TIMEOUT_MS, says how long it waited, and the call is refused', async (t) => {
  const { store, rt, adapter, t: thread, se } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  /** @type {any} */
  let answer = null;
  adapter.next.push(async (c) => {
    answer = await c.askPermission({ tool: 'Bash', summary: 'run the tests', input: { command: 'npm test' } });
  });
  rt.sendMessage(thread.id, { text: 'run the tests' });
  const card = () => store.items(thread.id).find((i) => i.kind === 'permission');
  for (let i = 0; i < 50 && !card(); i++) await new Promise(setImmediate);
  assert.equal(card()?.status, 'open');
  t.mock.timers.tick(POSTBOX_TIMEOUT_MS - 1);
  assert.equal(card().status, 'open', 'still open a moment before');
  t.mock.timers.tick(1);
  for (let i = 0; i < 50 && !answer; i++) await new Promise(setImmediate);
  assert.equal(card().status, 'expired');
  assert.equal(card().waitedMs, POSTBOX_TIMEOUT_MS);
  assert.deepEqual(answer, { allow: false, message: 'Nobody answered within 25 hours, so the request expired. Ask again if you still need it.' });
  assert.equal(store.state.sessions[se.id].needs, null, 'it no longer needs you');
  assert.throws(() => rt.act(thread.id, card().id, 'allow'), /already answered/);
  t.mock.timers.reset();
  await settle(rt);
});

test('#220 a card answered before the wait ends keeps its answer when the wait would have ended', async (t) => {
  const { store, rt, adapter, t: thread } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  adapter.next.push(async (c) => {
    await c.askPermission({ tool: 'Bash', summary: 'run the tests', input: { command: 'npm test' } });
  });
  rt.sendMessage(thread.id, { text: 'run the tests' });
  const card = () => store.items(thread.id).find((i) => i.kind === 'permission');
  for (let i = 0; i < 50 && !card(); i++) await new Promise(setImmediate);
  rt.act(thread.id, card().id, 'allow');
  t.mock.timers.tick(POSTBOX_TIMEOUT_MS);
  assert.equal(card().status, 'allowed', 'the expiry never fires on an answered card');
  assert.equal(card().waitedMs, undefined);
  t.mock.timers.reset();
  await settle(rt);
});
