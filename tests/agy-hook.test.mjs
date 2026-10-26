// #370: Antigravity CLI PreToolUse hook (server/adapters/agy-hook.mjs): tool classification, self-edit protection,
// permission_prompt over MCP, and fail-closed output under every error path.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { decideAgyTool, HOOK_SCRIPT, HOOK_TIMEOUT_S, isProtectedPath, mcpPost, runAgyHook } from '../server/adapters/agy-hook.mjs';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { expireWait } from '../server/permission-cards.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#370 condition 3: self-edit protection denies writes and edits to .agents/plugins, agy-hook.mjs and ~/.gemini/antigravity-cli', () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-prot-'));
  const ws = join(root, 'ws');
  const home = join(root, 'home');
  mkdirSync(join(ws, '.agents', 'plugins', 'postbox'), { recursive: true });
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  symlinkSync(join(ws, '.agents', 'plugins'), join(ws, 'linked-plugins'));
  symlinkSync(join(home, '.gemini', 'antigravity-cli'), join(ws, 'linked-agy'));

  for (const p of [
    '.agents/plugins/postbox/hooks.json',
    '.agents/plugins/other/x.json',
    '.agents',
    'linked-plugins/postbox/hooks.json',
    'linked-agy/settings.json',
    HOOK_SCRIPT,
    join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    '',
  ]) {
    assert.equal(isProtectedPath(p, { cwd: ws, home }), true, p);
    for (const mode of ['ask', 'auto', 'acceptEdits']) {
      for (const tool of ['write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content']) {
        const res = decideAgyTool({ toolCall: { name: tool, args: { Path: p } } }, { mode, folders: [ws], cwd: ws, home });
        assert.equal(res.decision, 'deny', `${tool} ${mode} ${p}`);
      }
    }
  }
  assert.equal(isProtectedPath('src/index.js', { cwd: ws, home }), false);
  assert.equal(isProtectedPath('.agents/rules/style.md', { cwd: ws, home }), false);
});

test('#370 conditions 2 & 3: decideAgyTool classifies file, command, web, MCP and subagent tools across ask, auto and acceptEdits', () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-decide-'));
  const ws = join(root, 'ws');
  const out = join(root, 'outside');
  const home = join(root, 'home');
  mkdirSync(ws, { recursive: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(join(home, '.gemini', 'antigravity-cli', 'mcp', 'postbox_postbox'), { recursive: true });
  symlinkSync(out, join(ws, 'escape-link'));
  const call = (name, args, mode = 'auto') => decideAgyTool({ toolCall: { name, args } }, { mode, folders: [ws], cwd: ws, home });

  assert.equal(call('read_file', { Path: join(ws, 'a.txt') }, 'ask').decision, 'allow');
  assert.equal(
    call('view_file', { AbsolutePath: join(home, '.gemini', 'antigravity-cli', 'mcp', 'postbox_postbox', 'show_block.json') }, 'ask').decision,
    'allow',
  );
  assert.deepEqual(call('read_file', { Path: join(out, 'secret.txt') }, 'auto'), {
    decision: 'ask',
    toolName: 'Read',
    input: { file_path: join(out, 'secret.txt') },
  });
  assert.equal(call('read_file', { Path: join(ws, 'escape-link', 'secret.txt') }, 'auto').decision, 'ask');

  assert.equal(call('write_file', { Path: join(ws, 'a.txt') }, 'auto').decision, 'allow');
  assert.equal(call('edit_file', { Path: join(ws, 'a.txt') }, 'acceptEdits').decision, 'allow');
  assert.deepEqual(call('write_file', { Path: join(ws, 'a.txt') }, 'ask'), { decision: 'ask', toolName: 'Write', input: { file_path: join(ws, 'a.txt') } });
  assert.deepEqual(call('replace_file_content', { TargetFile: join(out, 'a.txt') }, 'auto'), {
    decision: 'ask',
    toolName: 'Edit',
    input: { file_path: join(out, 'a.txt') },
  });
  assert.equal(call('write_file', { Path: join(ws, 'escape-link', 'a.txt') }, 'auto').decision, 'ask');

  for (const mode of ['ask', 'acceptEdits']) {
    assert.deepEqual(call('run_command', { CommandLine: 'git status', toolSummary: 'Check status' }, mode), {
      decision: 'ask',
      toolName: 'Bash',
      input: { command: 'git status', description: 'Check status' },
    });
    const flagged = call('run_command', { CommandLine: 'rm -rf .agents/plugins', toolSummary: 'Clean' }, mode);
    assert.match(flagged.input.description, /Touches Antigravity’s plugin, hook or settings — Clean/);
    assert.deepEqual(call('search_web', { query: 'postbox' }, mode), { decision: 'ask', toolName: 'WebSearch', input: { query: 'postbox' } });
    assert.deepEqual(call('read_url_content', { Url: 'https://example.com' }, mode), {
      decision: 'ask',
      toolName: 'WebFetch',
      input: { url: 'https://example.com' },
    });
  }
  assert.equal(call('call_mcp_tool', { ServerName: 'postbox_postbox', ToolName: 'show_block', Arguments: {} }).decision, 'allow');
  assert.equal(call('call_mcp_tool', { ServerName: 'postbox_postbox', ToolName: 'permission_prompt', Arguments: {} }).decision, 'deny');
  assert.deepEqual(call('call_mcp_tool', { ServerName: 'github', ToolName: 'create_issue', Arguments: { title: 'Hi' } }), {
    decision: 'ask',
    toolName: 'mcp__github__create_issue',
    input: { title: 'Hi' },
  });
  assert.equal(call('invoke_subagent', { TypeName: 'research' }).decision, 'allow');
});

function setupHookRuntime() {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-rpc-'));
  const store = new Store(null);
  const adapter = {
    name: 'antigravity-cli',
    capabilities: { promptTool: true, permissions: 'none' },
    next: /** @type {any[]} */ ([]),
    async deliver(_s, _m, ctx) {
      await this.next.shift()?.(ctx);
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: root },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: root });
  const p = rt.createPersona({ handle: 'gem', backend: 'antigravity-cli', permissionMode: 'auto', tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
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

test('#370 condition 2: runAgyHook fails closed to deny on every error path and never outputs ask, force_ask or empty stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-fail-'));
  const env = { POSTBOX_MCP_URL: 'http://127.0.0.1:1/mcp', POSTBOX_AGY_MODE: 'auto', POSTBOX_AGY_FOLDERS: JSON.stringify([root]) };
  const cmdEvent = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'ls /' } } });
  const rpcReply = (id, text) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result: { content: [{ text }] } }) });

  for (const [label, stdin, fetchImpl] of [
    ['invalid stdin', '{ bad json', async () => rpcReply('x', '{}')],
    ['network error', cmdEvent, async () => Promise.reject(new Error('ECONNREFUSED'))],
    ['HTTP 500', cmdEvent, async () => ({ ok: false, status: 500 })],
    ['mismatched rpc id', cmdEvent, async () => rpcReply('spoofed', '{"behavior":"allow"}')],
    ['missing behavior', cmdEvent, async (_u, init) => rpcReply(JSON.parse(init.body).id, '{}')],
    ['ask behavior', cmdEvent, async (_u, init) => rpcReply(JSON.parse(init.body).id, '{"behavior":"ask"}')],
  ]) {
    const printed = [];
    const out = await runAgyHook(String(stdin), { cwd: root, env, fetchImpl: /** @type {any} */ (fetchImpl), writeOut: (s) => printed.push(s) });
    assert.equal(out.decision, 'deny', String(label));
    assert.equal(printed.length, 1, String(label));
    assert.deepEqual(JSON.parse(printed[0]), out, String(label));
  }

  const act = [];
  const m = createAgyMapper({ persona: { permissionMode: 'auto' }, activity: (a) => act.push(a), status: () => {}, text: () => {} });
  m.push({
    event: 'step_update',
    step_update: {
      conversation_id: 'c1',
      step_index: 1,
      state: 'ERROR',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'ls' },
        error: { message: 'tool execution denied by PreToolUse hook: The person didn’t allow this.' },
      },
    },
  });
  assert.equal(act.at(-1).state, 'denied');
  assert.equal(act.at(-1).detail, 'The person didn’t allow this.');
  assert.equal(m.endedOnRefusal, null);
});

test('#370 condition 4: mcpPost uses node:http with HOOK_TIMEOUT_S instead of undici’s 300s headersTimeout', async () => {
  let capturedOpts = null;
  let capturedTimeout = 0;
  let sentBody = '';
  const fakeReq = (_url, opts, cb) => {
    capturedOpts = opts;
    return {
      setTimeout(ms) {
        capturedTimeout = ms;
      },
      on() {},
      end(body) {
        sentBody = String(body ?? '');
        const rpcId = JSON.parse(sentBody).id;
        const handlers = /** @type {Record<string, (arg?: any) => void>} */ ({});
        cb({
          statusCode: 200,
          setEncoding() {},
          on(ev, fn) {
            handlers[ev] = fn;
          },
        });
        handlers.data?.(JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: { content: [{ text: '{"behavior":"allow"}' }] } }));
        handlers.end?.();
      },
    };
  };
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-http-'));
  const env = { POSTBOX_MCP_URL: 'http://127.0.0.1:1/mcp', POSTBOX_AGY_MODE: 'auto', POSTBOX_AGY_FOLDERS: JSON.stringify([root]) };
  const out = await runAgyHook(JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'ls /' } } }), {
    cwd: root,
    env,
    fetchImpl: (url, init) => mcpPost(url, { ...init, requestImpl: /** @type {any} */ (fakeReq) }),
  });
  assert.deepEqual(out, { decision: 'allow' });
  assert.equal(capturedOpts?.timeout, HOOK_TIMEOUT_S * 1000);
  assert.equal(capturedTimeout, HOOK_TIMEOUT_S * 1000);
  assert.equal(HOOK_TIMEOUT_S * 1000 > 300_000, true);
});
