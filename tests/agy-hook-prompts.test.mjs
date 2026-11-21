// #370 condition 4: the hook asks through permission_prompt on a real runtime, and a card it raised answers it, by edit,
// deny or expiry, one request at a time. Moved from agy-hook.test.mjs, which is at its size ceiling.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { runAgyHook } from '../server/adapters/agy-hook.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { expireWait } from '../server/permission-cards.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { tempDir } from './temp-dirs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setupHookRuntime() {
  const root = tempDir('pb-agy-rpc-');
  const store = new Store(null);
  const adapter = {
    name: 'antigravity-cli',
    capabilities: { promptTool: true, promptHook: true, permissions: 'none' },
    next: /** @type {any[]} */ ([]),
    async deliver(_s, _m, ctx) {
      await this.next.shift()?.(ctx);
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: root },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: root });
  const p = rt.createPersona({ handle: 'gem', backend: 'antigravity-cli', permissionMode: 'auto', tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = arrange.sessionsIn(rt, t.id)[0];
  const env = { POSTBOX_MCP_URL: 'http://127.0.0.1:1/mcp', POSTBOX_AGY_MODE: 'auto', POSTBOX_AGY_FOLDERS: JSON.stringify([root]) };
  const fetchMcp = async (_url, init) => {
    const reply = await handleMcp(rt, se.id, JSON.parse(init.body), rt.turns.get(se.id)?.token ?? null);
    return { ok: true, status: 200, json: async () => reply };
  };
  return { root, store, adapter, rt, t, se, env, fetchMcp };
}

test('#370 condition 4: runAgyHook asks through permission_prompt with its own request id and handles edit, deny and expiry', async () => {
  const { root, store, adapter, rt, t, env, fetchMcp } = setupHookRuntime();
  const cmdEvent = JSON.stringify({
    toolCall: { name: 'run_command', args: { CommandLine: 'touch /tmp/a.txt', WaitMsBeforeAsync: 5000, toolSummary: 'Touch a.txt' } },
  });
  /** @type {any[]} */
  const results = [];
  adapter.next.push(async () => {
    const p1 = runAgyHook(cmdEvent, { cwd: root, env, fetchImpl: /** @type {any} */ (fetchMcp) });
    await sleep(10);
    const card1 = store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');
    assert.match(card1.toolUseId, /^agy-hook-/);
    rt.act(t.id, card1.id, 'edit', { command: 'touch edited.txt' });
    results.push(await p1);

    const p2 = runAgyHook(cmdEvent, { cwd: root, env, fetchImpl: /** @type {any} */ (fetchMcp) });
    await sleep(10);
    const card2 = store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');
    rt.act(t.id, card2.id, 'deny', { reason: 'Do not touch files.' });
    results.push(await p2);

    const p3 = runAgyHook(cmdEvent, { cwd: root, env, fetchImpl: /** @type {any} */ (fetchMcp) });
    await sleep(10);
    const card3 = store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');
    expireWait(rt, card3.id);
    results.push(await p3);
  });
  rt.sendMessage(t.id, { text: 'go' });
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);

  assert.deepEqual(results[0], {
    decision: 'allow',
    overwrite: { CommandLine: 'touch edited.txt', WaitMsBeforeAsync: 5000, toolSummary: 'Touch a.txt' },
  });
  assert.deepEqual(results[1], { decision: 'deny', reason: 'The person didn’t allow this. Their reason: Do not touch files.' });
  assert.equal(results[2].decision, 'deny');
  assert.match(results[2].reason, /Nobody answered within/);
});

test('#370 condition 4: disconnecting permission_prompt expires only that request’s card when two requests overlap', async () => {
  const { store, adapter, rt, t, se } = setupHookRuntime();
  /** @type {any} */
  let outcome = null;
  const callPrompt = (id, cmd, sig) => {
    const body = {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: cmd }, tool_use_id: id } },
    };
    return handleMcp(rt, se.id, body, rt.turns.get(se.id)?.token ?? null, sig);
  };
  adapter.next.push(async () => {
    const [ac1, ac2] = [new AbortController(), new AbortController()];
    const [p1, p2] = [callPrompt('agy-hook-1', 'touch one.txt', ac1.signal), callPrompt('agy-hook-2', 'touch two.txt', ac2.signal)];
    await sleep(10);
    const card1 = store.items(t.id).find((i) => i.kind === 'permission' && i.toolUseId === 'agy-hook-1');
    const card2 = store.items(t.id).find((i) => i.kind === 'permission' && i.toolUseId === 'agy-hook-2');
    assert.deepEqual([card1.status, card2.status], ['open', 'open']);
    ac1.abort();
    const rpc1 = /** @type {any} */ (await p1);
    assert.deepEqual([store.item(t.id, card1.id).status, store.item(t.id, card2.id).status], ['expired', 'open']);
    assert.throws(() => rt.act(t.id, card1.id, 'allow', {}), /already answered/);
    rt.act(t.id, card2.id, 'allow', {});
    const rpc2 = /** @type {any} */ (await p2);
    outcome = [
      store.item(t.id, card1.id).status,
      store.item(t.id, card2.id).status,
      JSON.parse(rpc1.result.content[0].text).behavior,
      JSON.parse(rpc2.result.content[0].text).behavior,
    ];
  });
  rt.sendMessage(t.id, { text: 'go' });
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  assert.deepEqual(outcome, ['expired', 'allowed', 'deny', 'allow']);
});
