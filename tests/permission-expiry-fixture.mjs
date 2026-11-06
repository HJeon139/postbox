// What the #721 expiry specs share: a Claude Code agent whose turns the test scripts, a card it waits on, and its notes.
// Moved from tests/permission-expiry.test.mjs, unchanged but for the exports.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const folders = [];
after(() => Promise.all(folders.map((f) => rm(f, { recursive: true, force: true }))));
export const EXPIRED_NOTE =
  /^\[Postbox\] Your request to run the deploy \(`make deploy`\) expired before the person answered it, so it didn’t run\. Ask again if you still need it\.$/;

/** A Claude Code agent whose turns the test scripts: each step is one turn, and every turn’s message is kept. */
export async function setup() {
  const folder = await mkdtemp(join(tmpdir(), 'pb-expiry-'));
  folders.push(folder);
  const store = new Store(null);
  const calls = [];
  const next = [];
  const adapter = {
    name: 'claude-code',
    async folderFor() {
      return folder;
    },
    async deliver(_session, message, ctx) {
      calls.push(message);
      const step = next.shift() ?? (async (c) => c.text('ok'));
      await step(ctx);
    },
  };
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: folder },
  });
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'deployer', backend: 'claude-code', tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  /** Starts a turn whose call waits on a card for the deploy, and returns the card once it shows. */
  const ask = async () => {
    const answers = [];
    next.push(async (c) => {
      answers.push(await c.askPermission({ tool: 'Bash', summary: 'run the deploy', detail: 'make deploy', input: { command: 'make deploy' } }));
      c.text('ok');
    });
    rt.sendMessage(t.id, { text: 'deploy it' });
    const card = () => store.pending.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');
    for (let i = 0; i < 100 && !card(); i++) await new Promise(setImmediate);
    assert.ok(card(), 'the card shows');
    return { card: card(), answers };
  };
  return { store, rt, t, se, calls, ask, now: () => store.state.sessions[se.id] };
}
export const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(5);
};
export const notes = (se) => (se.context ?? []).filter((n) => /expired before the person answered/.test(n));
