// Permission cards and refusal cards (server/permission-cards.mjs): what they offer for a call no one rule can allow
// (#238).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
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
/** A turn whose Bash call auto mode’s classifier refused, as the stream reports it. */
async function refused(rt, adapter, t, command) {
  adapter.next.push(async (c) =>
    c.denied({
      toolUseId: `tu-${command.length}`,
      tool: 'Bash',
      input: { command },
      label: 'Run the tests',
      reason: '[Data Exfiltration]',
      reasonType: 'classifier',
    }),
  );
  rt.sendMessage(t.id, { text: 'run the tests' });
  await settle(rt);
  return rt.store.items(t.id).findLast((i) => i.kind === 'denial');
}

test('#238 a refused chained command offers no Allow once or Always allow, and refuses both if asked', async () => {
  const { store, rt, adapter, t, se } = await setup();
  const card = await refused(rt, adapter, t, 'cd src && python -m pytest -q 2>&1 | tail -20');
  assert.deepEqual(card.rules, { once: null, always: null, alwaysWords: '' });
  const turns = adapter.calls.length;
  for (const action of ['once', 'always'])
    await assert.rejects(rt.act(t.id, card.id, action), { status: 409, message: /checks each part of a chained command on its own/ });
  assert.equal(store.item(t.id, card.id).status, 'open', 'it stays open, for Leave it');
  assert.deepEqual(store.state.sessions[se.id].allowOnce ?? [], [], 'nothing is passed to the next turn');
  await settle(rt);
  assert.equal(adapter.calls.length, turns, 'the agent isn’t told to try again');
  await rt.act(t.id, card.id, 'leave');
  assert.equal(store.item(t.id, card.id).status, 'left');
});

test('#238 Allow once on a single command passes its exact rule, and tells the agent to retry it exactly', async () => {
  const { rt, adapter, t } = await setup();
  const card = await refused(rt, adapter, t, 'python -m pytest -q');
  await rt.act(t.id, card.id, 'once');
  await settle(rt);
  const next = adapter.calls.at(-1);
  assert.deepEqual(next.ctx.allowOnce, ['Bash(python -m pytest -q)']);
  assert.match(next.message.text, /try it again exactly as before, since the allow covers only that exact call/);
});

test('#238 a permission card for a chained command offers no Always allow, since the rule it saved would never match', async () => {
  const { store, rt, adapter, t } = await setup();
  let answer = null;
  adapter.next.push(async (c) => {
    answer = await c.askPermission({ tool: 'Bash', summary: 'run the tests', input: { command: 'cd src && npm test' } });
  });
  rt.sendMessage(t.id, { text: 'run the tests' });
  await sleep(20);
  const card = store.items(t.id).find((i) => i.kind === 'permission');
  assert.equal(card.always, null);
  rt.act(t.id, card.id, 'allow');
  await settle(rt);
  assert.equal(answer.allow, true, 'Allow still answers the waiting call');
});
