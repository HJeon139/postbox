// #220: permission_prompt is the Claude Code CLI’s way to ask (--permission-prompt-tool). A backend that asks another
// way (the Agent SDK’s canUseTool) or can’t ask (Kiro) isn’t offered it, and a call from one is refused at once:
// otherwise it held a card and the call open for up to POSTBOX_TIMEOUT_MS.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { AgentSdkAdapter } from '../server/adapters/agent-sdk.mjs';
import { KIRO_CAPABILITIES } from '../server/adapters/kiro-cli.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A backend whose turns the test scripts, with a real backend’s name and capabilities. */
const scripted = (name, capabilities) => ({
  name,
  capabilities,
  next: [],
  async deliver(_session, _message, ctx) {
    await (this.next.shift() ?? (async (c) => c.text('ok')))(ctx);
  },
});

function setup(backend, capabilities) {
  const store = new Store(null);
  const adapter = scripted(backend, capabilities);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'researcher', backend, tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  return { store, rt, adapter, t, se: rt.sessionsIn(t.id)[0] };
}
const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(5);
};
const rpc = (rt, se, method, params) => handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method, params }, rt.turns.get(se.id)?.token ?? null);
const PROMPT = { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu1' } };

for (const [label, backend, capabilities] of [
  ['A Kiro CLI', 'kiro-cli', KIRO_CAPABILITIES],
  ['An Agent SDK', 'agent-sdk', new AgentSdkAdapter({ sdk: { query() {} }, workRoot: '/nowhere' }).capabilities],
])
  test(`#220 ${label} agent isn’t offered permission_prompt, and its call to it is refused at once, with no card`, async () => {
    const { store, rt, adapter, t, se } = setup(backend, capabilities);
    /** @type {any} */
    let seen = null;
    adapter.next.push(async () => {
      const listed = (await rpc(rt, se, 'tools/list')).result.tools.map((x) => x.name);
      seen = { listed, reply: await rpc(rt, se, 'tools/call', PROMPT) };
    });
    rt.sendMessage(t.id, { text: 'clean the build' });
    await settle(rt);
    assert.ok(seen.listed.includes('show_block') && !seen.listed.includes('permission_prompt'));
    assert.equal(seen.reply.result.isError, true);
    assert.match(seen.reply.result.content[0].text, /^Postbox didn’t run permission_prompt: it’s how the Claude Code CLI asks/);
    assert.equal(store.items(t.id).filter((i) => i.kind === 'permission').length, 0, 'no card');
    assert.equal(store.state.sessions[se.id].needs, null, 'nothing needs you');
  });

test('#220 a Claude Code agent is offered permission_prompt and asks through it, even once its persona moves mid-turn', async () => {
  const { store, rt, adapter, t, se } = setup('claude-code', undefined);
  rt.adapters.register(scripted('agent-sdk', { promptTool: false }));
  /** @type {any} */
  let listed = null;
  /** @type {Promise<any>|null} */
  let pending = null;
  adapter.next.push(async () => {
    listed = (await rpc(rt, se, 'tools/list')).result.tools.map((x) => x.name);
    // The running CLI was started with --permission-prompt-tool: the move reaches its next turn, not this call.
    rt.updatePersona(se.personaId, { backend: 'agent-sdk' });
    pending = rpc(rt, se, 'tools/call', PROMPT);
    await sleep(10);
    const card = store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');
    rt.act(t.id, card.id, 'allow');
    await pending;
  });
  rt.sendMessage(t.id, { text: 'clean the build' });
  await settle(rt);
  assert.ok(listed.includes('permission_prompt'));
  assert.equal(JSON.parse((await pending).result.content[0].text).behavior, 'allow');
  assert.ok(!(await rpc(rt, se, 'tools/list')).result.tools.some((x) => x.name === 'permission_prompt'), 'its next turn is the SDK’s');
});
