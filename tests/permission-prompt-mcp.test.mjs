// MCP permission_prompt, as the Claude Code CLI calls it (--permission-prompt-tool): the shape of its answer, and the
// suggestions, agent id, edit and Always allow it carries (#66). Moved out of tests/runtime.test.mjs and
// tests/permissions.test.mjs, which are at their length limits.

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function setup({ usesHostSetup = true } = {}) {
  const root = tempDir('pb-perm-');
  const folder = join(root, 'work');
  const home = join(root, 'home');
  await mkdir(folder);
  await mkdir(home);
  const store = new Store(null);
  const adapter = new ScriptedClaude(folder);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home },
  });
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'coder', backend: 'claude-code', permissionMode: 'ask', usesHostSetup, tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  return { root, folder, home, store, rt, adapter, p, t, se };
}
const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(5);
};
const openCard = (store, t) => store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');

test('MCP permission_prompt answers in the shape Claude Code expects', async () => {
  const { rt, store, t, adapter } = await setup();
  let reply = null;
  adapter.next.push(async (c) => {
    const se = rt.sessionsIn(t.id)[0];
    const pending = handleMcp(
      rt,
      se.id,
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'ls', description: 'List files' } } },
      },
      new URL(c.mcpUrl).searchParams.get('turn'),
    );
    await sleep(10);
    const card = store.items(t.id).find((i) => i.kind === 'permission');
    assert.equal(card.summary, 'run a command: List files');
    rt.act(t.id, card.id, 'allow');
    reply = await pending;
    c.text('ok');
  });
  rt.sendMessage(t.id, { text: 'list' });
  await settle(rt);
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { behavior: 'allow', updatedInput: { command: 'ls', description: 'List files' } });
});

test('#66: MCP permission_prompt passes suggestions and the agent id, and answers with your edit or Always allow', async () => {
  const { rt, store, t, adapter, se } = await setup();
  const replies = [];
  // The turn’s own token, as Claude Code sends it (#54).
  const token = () => rt.turns.get(se.id)?.token ?? null;
  const ask = (args) => handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'permission_prompt', arguments: args } }, token());
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//data/**' }], behavior: 'allow', destination: 'localSettings' }];
  adapter.next.push(async (c) => {
    c.subagentNames(({ agentId }) => (agentId === 'task-1' ? 'Explore' : null));
    const one = ask({ tool_name: 'Read', input: { file_path: '/data/a' }, tool_use_id: 'tu1', permission_suggestions: suggestions, agent_id: 'task-1' });
    await sleep(10);
    const card = openCard(store, t);
    assert.equal(card.who, 'Explore');
    rt.act(t.id, card.id, 'always', {});
    replies.push(await one);
    const two = ask({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu2' });
    await sleep(10);
    rt.act(t.id, openCard(store, t).id, 'edit', { command: 'ls -la' });
    replies.push(await two);
  });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  const [a, b] = replies.map((r) => JSON.parse(r.result.content[0].text));
  assert.deepEqual(a, { behavior: 'allow', updatedInput: { file_path: '/data/a' }, updatedPermissions: suggestions });
  assert.deepEqual(b, { behavior: 'allow', updatedInput: { command: 'ls -la' } });
});
