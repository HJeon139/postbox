// #370: Antigravity CLI PreToolUse hook (server/adapters/agy-hook.mjs): tool classification, self-edit protection,
// permission_prompt over MCP, and fail-closed output under every error path.

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyTool, HOOK_SCRIPT, HOOK_TIMEOUT_S, isProtectedPath, mcpPost, runAgyHook } from '../server/adapters/agy-hook.mjs';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';
import { tempDir } from './temp-dirs.mjs';

test('#370 condition 3: self-edit protection denies writes and edits to .agents/plugins, agy-hook.mjs and ~/.gemini/antigravity-cli', () => {
  const root = tempDir('pb-agy-prot-');
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
    assert.equal(isProtectedPath(p, { cwd: ws, scriptPath: HOOK_SCRIPT, home }), true, p);
    for (const mode of ['ask', 'auto', 'acceptEdits']) {
      for (const tool of ['write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content']) {
        const res = decideAgyTool({ toolCall: { name: tool, args: { Path: p } } }, { mode, folders: [ws], cwd: ws, home });
        assert.equal(res.decision, 'deny', `${tool} ${mode} ${p}`);
      }
    }
  }
  assert.equal(isProtectedPath('src/index.js', { cwd: ws, scriptPath: HOOK_SCRIPT, home }), false);
  assert.equal(isProtectedPath('.agents/rules/style.md', { cwd: ws, scriptPath: HOOK_SCRIPT, home }), false);
});

test('#370 conditions 2 & 3: decideAgyTool classifies file, command, web, MCP and subagent tools across ask, auto and acceptEdits', () => {
  const root = tempDir('pb-agy-decide-');
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
  assert.deepEqual(call('call_mcp_tool', { ServerName: 'github', ToolName: 'create_issue', Arguments: { title: 'Hi' } }, 'ask'), {
    decision: 'ask',
    toolName: 'mcp__github__create_issue',
    input: { title: 'Hi' },
  });
  assert.equal(call('invoke_subagent', { TypeName: 'research' }).decision, 'allow');
});

test('#370 condition 2: runAgyHook fails closed to deny on every error path and never outputs ask, force_ask or empty stdout', async () => {
  const root = tempDir('pb-agy-fail-');
  const env = { POSTBOX_MCP_URL: 'http://127.0.0.1:1/mcp', POSTBOX_AGY_MODE: 'auto', POSTBOX_AGY_FOLDERS: JSON.stringify([root]) };
  const cmdEvent = JSON.stringify({ conversationId: 'c1', stepIdx: 1, toolCall: { name: 'run_command', args: { CommandLine: 'ls /' } } });
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
  const root = tempDir('pb-agy-http-');
  const env = { POSTBOX_MCP_URL: 'http://127.0.0.1:1/mcp', POSTBOX_AGY_MODE: 'auto', POSTBOX_AGY_FOLDERS: JSON.stringify([root]) };
  const out = await runAgyHook(JSON.stringify({ conversationId: 'c1', stepIdx: 1, toolCall: { name: 'run_command', args: { CommandLine: 'ls /' } } }), {
    cwd: root,
    env,
    fetchImpl: (url, init) => mcpPost(url, { ...init, requestImpl: /** @type {any} */ (fakeReq) }),
  });
  assert.deepEqual(out, { decision: 'allow' });
  assert.equal(capturedOpts?.timeout, HOOK_TIMEOUT_S * 1000);
  assert.equal(capturedTimeout, HOOK_TIMEOUT_S * 1000);
  assert.equal(HOOK_TIMEOUT_S * 1000 > 300_000, true);
});
