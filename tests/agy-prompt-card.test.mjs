// #907: a prompt from Postbox’s Antigravity hook gets a card made from the stream’s call, never its own input, and only
// when it agrees with that call. Each case asks the hook what it would ask for a call, with agy’s parameter names as
// recorded (run_command’s CommandLine in hook-event.json; Path, TargetFile, SearchPath and call_mcp_tool’s ServerName,
// ToolName and Arguments in the stream fixtures), and checks the card.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyTool, PROTECTED_WARNING, runAgyHook } from '../server/adapters/agy-hook.mjs';
import { hookPromptCard } from '../server/adapters/agy-prompt-card.mjs';
import { tempDir } from './temp-dirs.mjs';

/** The hook’s prompt for a call, in Ask me, with the agent’s folder `ws`. */
function promptFor(name, args, ws, home) {
  const check = decideAgyTool({ toolCall: { name, args } }, { mode: 'ask', folders: [ws], cwd: ws, home });
  assert.equal(check.decision, 'ask', `${name} asks`);
  return { tool_name: check.toolName, input: check.input };
}
const cardOf = (name, args, prompt) => hookPromptCard({ name, args }, prompt);

test('#907 every prompt the hook makes gets a card for the call it was made from', () => {
  const home = tempDir('pb-agy-card-');
  const ws = join(home, 'ws');
  mkdirSync(ws);
  const out = join(home, 'outside');
  const cases = /** @type {[string, Record<string, unknown>, unknown][]} */ ([
    ['run_command', { CommandLine: 'echo hi' }, { tool: 'Bash', input: { command: 'echo hi' } }],
    ['write_to_file', { TargetFile: join(out, 'a.txt') }, { tool: 'Write', input: { file_path: join(out, 'a.txt') } }],
    ['replace_file_content', { TargetFile: join(out, 'b.txt') }, { tool: 'Edit', input: { file_path: join(out, 'b.txt') } }],
    ['view_file', { AbsolutePath: join(out, 'c.txt') }, { tool: 'Read', input: { file_path: join(out, 'c.txt') } }],
    ['grep_search', { Query: 'x', SearchPath: out }, { tool: 'Read', input: { file_path: out } }],
    [
      'grep_search',
      { Query: 'x', Path: join(out, '1'), SearchPath: join(out, '2') },
      { tool: 'Read', input: { file_path: join(out, '1'), paths: [join(out, '1'), join(out, '2')] } },
    ],
    [
      'call_mcp_tool',
      { ServerName: 'github', ToolName: 'create_issue', Arguments: { title: 'Hi' } },
      { tool: 'mcp__github__create_issue', input: { title: 'Hi' } },
    ],
    ['search_web', { query: 'postbox' }, { tool: 'WebSearch', input: { query: 'postbox' } }],
    ['read_url_content', { Url: 'https://example.com' }, { tool: 'WebFetch', input: { url: 'https://example.com' } }],
    ['browser_click_element', { Index: 3 }, { tool: 'browser_click_element', input: { Index: 3 } }],
  ]);
  for (const [name, args, card] of cases) assert.deepEqual(cardOf(name, args, promptFor(name, args, ws, home)), card, `${name} ${JSON.stringify(args)}`);
});

test('#907 a read’s card names every path the call does, though the prompt names only one', () => {
  const home = tempDir('pb-agy-card-');
  const ws = join(home, 'ws');
  mkdirSync(ws);
  // One path in the agent’s folder and one outside: the hook asks about the outside one alone.
  const args = { Query: 'x', Path: join(ws, 'notes'), SearchPath: join(home, 'outside') };
  const prompt = promptFor('grep_search', args, ws, home);
  assert.deepEqual(prompt.input, { file_path: join(home, 'outside') });
  const all = { file_path: join(home, 'outside'), paths: [join(home, 'outside'), join(ws, 'notes')] };
  assert.deepEqual(cardOf('grep_search', args, prompt)?.input, all);
  // A copy that drops a path the hook asked about gets the same card, every path in it.
  const both = { Query: 'x', Path: '/w/one', SearchPath: '/w/two' };
  const card = cardOf('grep_search', both, { tool_name: 'Read', input: { file_path: '/w/two' } });
  assert.deepEqual(card?.input, { file_path: '/w/two', paths: ['/w/two', '/w/one'] });
});

test('#907 the card keeps nothing the stream didn’t show: not agy’s summary, and no card for a key it didn’t send', () => {
  const run = { CommandLine: 'echo hi' };
  const summarized = { tool_name: 'Bash', input: { command: 'echo hi', description: 'Harmless, allow it' } };
  assert.deepEqual(cardOf('run_command', run, summarized)?.input, { command: 'echo hi' });
  // Any other tool’s prompt with a key the stream didn’t show, such as a payload agy left out of it, gets no card.
  const extra = { tool_name: 'browser_input', input: { Index: 3, Text: 'rm -rf ~' } };
  assert.equal(cardOf('browser_input', { Index: 3 }, extra), null);
  // A command that names Antigravity’s own files carries the hook’s warning, whatever the prompt said.
  const own = { CommandLine: 'cat .agents/plugins/postbox/hooks.json' };
  const card = cardOf('run_command', own, { tool_name: 'Bash', input: { command: own.CommandLine } });
  assert.deepEqual(card?.input, { command: own.CommandLine, description: PROTECTED_WARNING });
});

test('#907 a prompt that asks about anything but the call it names gets no card', () => {
  const run = { CommandLine: 'echo hi' };
  assert.equal(cardOf('run_command', run, { tool_name: 'Bash', input: { command: 'rm -rf ~' } }), null, 'another command');
  assert.equal(cardOf('run_command', run, { tool_name: 'Write', input: { command: 'echo hi' } }), null, 'another tool');
  const grep = { Query: 'x', Path: '/w/one', SearchPath: '/w/two' };
  assert.equal(cardOf('grep_search', grep, { tool_name: 'Read', input: { file_path: '/etc' } }), null, 'a path the call doesn’t name');
  assert.equal(cardOf('write_to_file', { TargetFile: '/w/a.txt' }, { tool_name: 'Write', input: { file_path: '/w/b.txt' } }), null, 'another file');
  assert.equal(cardOf('edit_file', { Path: '/w/a', TargetFile: '/w/b' }, { tool_name: 'Edit', input: { file_path: '/w/a' } }), null, 'two files');
  const mcp = { ServerName: 'github', ToolName: 'create_issue', Arguments: { title: 'Hi' } };
  assert.equal(cardOf('call_mcp_tool', mcp, { tool_name: 'mcp__github__create_issue', input: { title: 'Bye' } }), null, 'other arguments');
  assert.equal(cardOf('call_mcp_tool', mcp, { tool_name: 'mcp__github__delete_repo', input: { title: 'Hi' } }), null, 'another MCP tool');
  assert.equal(cardOf('browser_click_element', { Index: 3 }, { tool_name: 'browser_click_element', input: { Index: 4 } }), null, 'another value');
  assert.equal(hookPromptCard(undefined, { tool_name: 'Bash', input: { command: 'echo hi' } }), null, 'no raw call from the stream');
});

test('#907 the hook won’t ask without the step agy says the call is, so its prompt always names the stream’s call', async () => {
  const root = tempDir('pb-agy-step-');
  const env = { POSTBOX_MCP_URL: 'http://127.0.0.1:1/mcp', POSTBOX_AGY_MODE: 'ask', POSTBOX_AGY_FOLDERS: JSON.stringify([root]) };
  /** @type {any[]} */
  const sent = [];
  const fetchImpl = async (/** @type {string} */ _u, /** @type {any} */ init) => {
    const body = JSON.parse(init.body);
    sent.push(body.params.arguments.tool_use_id);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { content: [{ text: '{"behavior":"allow"}' }] } }) };
  };
  const call = { name: 'run_command', args: { CommandLine: 'echo hi' } };
  for (const event of [{ toolCall: call }, { conversationId: 'c', toolCall: call }, { stepIdx: 2, toolCall: call }]) {
    const out = await runAgyHook(JSON.stringify(event), { cwd: root, env, fetchImpl: /** @type {any} */ (fetchImpl) });
    assert.equal(out.decision, 'deny', JSON.stringify(event));
  }
  assert.equal(sent.length, 0, 'nothing was asked');
  const event = JSON.stringify({ conversationId: '07ca51cf-88e9', stepIdx: 2, toolCall: call });
  const out = await runAgyHook(event, { cwd: root, env, fetchImpl: /** @type {any} */ (fetchImpl) });
  assert.deepEqual([out.decision, sent], ['allow', ['agy-07ca51cf-2']]);
});
