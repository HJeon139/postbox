// Permission cards and refusal cards (server/permission-cards.mjs): what they offer for a call no one rule can allow
// (#238), and how long a card waits (#220).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { codexApproval } from '../server/adapters/codex-approval.mjs';
import { POSTBOX_TIMEOUT_MS } from '../server/adapters/setup.mjs';
import { CARD_WAIT_MS } from '../server/permission-cards.mjs';
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

// Claude Code drops the call at POSTBOX_TIMEOUT_MS (the MCP server’s timeout, #217), so an answer after it would go
// nowhere; the card expires a minute before, at CARD_WAIT_MS. node:test’s mock timers stand in for the clock, so the
// test doesn’t wait 25 hours.
test('#220 a card nobody answers expires at CARD_WAIT_MS, says how long it waited, and the call is refused', async (t) => {
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
  t.mock.timers.tick(CARD_WAIT_MS - 1);
  assert.equal(card().status, 'open', 'still open a moment before');
  t.mock.timers.tick(1);
  for (let i = 0; i < 50 && !answer; i++) await new Promise(setImmediate);
  assert.equal(card().status, 'expired');
  assert.equal(card().waitedMs, CARD_WAIT_MS);
  assert.deepEqual(answer, { allow: false, message: 'Nobody answered within 25 hours, so the request expired. Ask again if you still need it.' });
  assert.equal(store.state.sessions[se.id].needs, null, 'it no longer needs you');
  assert.throws(() => rt.act(thread.id, card().id, 'allow'), /already answered/);
  t.mock.timers.reset();
  await settle(rt);
});

// Claude Code’s clock for the call starts when it sends it, the card’s only once the call reaches Postbox. With the same
// length on both, Claude Code gave up first, and for that moment the card took an answer that went nowhere.
test('#220 a card expires before Claude Code’s deadline for the call, even when the call took a while to arrive', async (t) => {
  const { store, rt, adapter, t: thread } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  /** @type {any} */
  let answer = null;
  adapter.next.push(async (c) => {
    answer = await c.askPermission({ tool: 'Bash', summary: 'run the tests', input: { command: 'npm test' } });
  });
  rt.sendMessage(thread.id, { text: 'run the tests' });
  const card = () => store.items(thread.id).find((i) => i.kind === 'permission');
  for (let i = 0; i < 50 && !card(); i++) await new Promise(setImmediate);
  // The call left Claude Code 30 seconds before the card was made (a slow trip), so its deadline is that much sooner.
  const trip = 30 * 1000;
  /** @type {string|undefined} */
  let atDeadline;
  setTimeout(() => {
    atDeadline = card().status;
  }, POSTBOX_TIMEOUT_MS - trip);
  t.mock.timers.tick(POSTBOX_TIMEOUT_MS);
  assert.equal(atDeadline, 'expired', 'the card had expired when Claude Code gave up on the call');
  for (let i = 0; i < 50 && !answer; i++) await new Promise(setImmediate);
  assert.equal(answer?.allow, false, 'and the no reached the call');
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

// Codex fixes its approval policy at turn/start and has no way to change it mid-turn, so it asks Postbox for every
// command until the turn ends. Switching the agent to Run everything answers those sandbox asks at once (#371); an ask
// a permission rule forced, and a write outside Postbox, keep their cards.
test('#371 Run everything set mid-turn answers Codex’s own sandbox asks, not ones a rule forced or a write', async () => {
  const { store, rt, adapter, t, se } = await setup();
  const command = (cmd) => ({ method: 'item/commandExecution/requestApproval', params: { itemId: `cmd_${cmd.length}`, command: cmd, cwd: '/work' } });
  const open = () => store.items(t.id).find((x) => x.kind === 'permission' && x.status === 'open');
  /** @type {any[]} */
  const answers = [];
  /** Runs one ask in a turn of its own and returns its card, if one opened, after Stop answers it no. */
  const ask = async (/** @type {(c: any) => Promise<any>} */ how) => {
    adapter.next.push(async (c) => {
      answers.push(await how(c));
    });
    rt.sendMessage(t.id, { text: 'go on' });
    for (let i = 0; i < 40 && !open(); i++) await sleep(5);
    const card = open();
    if (card) rt.stop(se.id);
    await settle(rt);
    return card;
  };
  await rt.setPermissionMode(se.personaId, 'bypass');
  // Codex’s own ask, in the shape it sends (no input): allowed without a card.
  assert.equal(await ask((c) => codexApproval(c, command('npm test'))), undefined);
  assert.deepEqual(answers.at(-1), { decision: 'accept' });
  // A write outside Postbox, in Codex’s shape too, keeps its card (#112).
  assert.equal((await ask((c) => codexApproval(c, command('gh pr create --title x'))))?.summary, 'run a command');
  // An MCP tool that publishes, through Codex’s tool branch, keeps its card and its draft.
  const tool = {
    method: 'mcpServer/elicitation/request',
    params: {
      serverName: 'github',
      message: 'Allow the github MCP server to run tool "create_issue"?',
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'create_issue', tool_params: { title: 'x', body: 'The draft' } },
    },
  };
  assert.deepEqual((await ask((c) => codexApproval(c, tool)))?.draft, { field: 'body', text: 'The draft' });
  // An MCP server asking the person for input isn’t a sandbox ask: its card stays.
  const input = { method: 'mcpServer/elicitation/request', params: { serverName: 'github', message: 'Pick a repository' } };
  assert.equal((await ask((c) => codexApproval(c, input)))?.summary, 'respond to github');
  // An ask a rule forced, as Claude Code’s permission_prompt or the Agent SDK’s canUseTool sends it: its card stays.
  assert.equal((await ask((c) => c.askPermission({ tool: 'Bash', summary: 'run the tests', input: { command: 'rm -rf build' } })))?.summary, 'run the tests');
  // Back to Ask me mid-turn: Codex’s own asks get cards again.
  await rt.setPermissionMode(se.personaId, 'ask');
  assert.equal((await ask((c) => codexApproval(c, command('npm test'))))?.summary, 'run a command');
});
