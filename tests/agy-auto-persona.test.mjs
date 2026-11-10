// #416, option A (the person’s pick, 8 Nov): Antigravity’s Auto works like Run everything for the tools its persona
// has. In Auto, a command runs when the persona has shell, a search or fetch when it has web.fetch, and an MCP tool
// outside Postbox when it doesn’t publish. A publishing tool is refused in every mode for a persona that can’t publish
// outside Postbox, as Claude Code’s --disallowedTools refuses it. Ask me, Accept edits, Antigravity’s own files and
// edits in .git are unchanged.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyTool, runAgyHook } from '../server/adapters/agy-hook.mjs';
import { tempDir } from './temp-dirs.mjs';

function workspace() {
  const root = tempDir('pb-agy-persona-');
  const ws = join(root, 'ws');
  const home = join(root, 'home');
  mkdirSync(join(ws, '.git'), { recursive: true });
  mkdirSync(home);
  /** @param {string} name @param {any} args @param {{ mode?: string, tools?: string[], canPublish?: boolean }} [o] */
  const call = (name, args, { mode = 'auto', tools = [], canPublish = false } = {}) =>
    decideAgyTool({ toolCall: { name, args } }, { mode, folders: [ws], cwd: ws, home, tools, canPublish });
  return { ws, home, call };
}
const cmd = (CommandLine) => ['run_command', { CommandLine }];
const mcp = (ServerName, ToolName) => ['call_mcp_tool', { ServerName, ToolName, Arguments: {} }];
const SHELL = { tools: ['shell'] };
const WEB = { tools: ['web.fetch'] };

test('#416 in Auto with shell, any command runs; without shell it still asks', () => {
  const { call } = workspace();
  for (const c of ['npm test', 'git commit -m x', 'python3 x.py', 'ls | wc -l', 'curl https://example.com/a?b=1'])
    assert.equal(call(...cmd(c), SHELL).decision, 'allow', c);
  assert.equal(call(...cmd('npm test')).decision, 'ask', 'no shell');
});

test('#416 in Auto with web.fetch, a search and a fetch with a query run; without it they ask', () => {
  const { call } = workspace();
  assert.equal(call('search_web', { query: 'postbox' }, WEB).decision, 'allow');
  assert.equal(call('read_url_content', { Url: 'https://example.com/?q=1' }, WEB).decision, 'allow');
  assert.equal(call('search_web', { query: 'postbox' }, SHELL).decision, 'ask');
});

test('#416 in Auto, an MCP tool outside Postbox runs unless it publishes; a publishing one is refused without “Can publish”', () => {
  const { call } = workspace();
  assert.equal(call(...mcp('github', 'create_issue')).decision, 'allow');
  for (const mode of ['auto', 'ask', 'acceptEdits']) {
    const refused = call(...mcp('slack', 'send_message'), { mode });
    assert.equal(refused.decision, 'deny', mode);
    assert.match(refused.reason, /publish/);
  }
  assert.equal(call(...mcp('slack', 'send_message'), { canPublish: true }).decision, 'allow', 'Auto, may publish');
  assert.equal(call(...mcp('slack', 'send_message'), { mode: 'ask', canPublish: true }).decision, 'ask', 'Ask me, may publish');
});

test('#416 what A keeps: Antigravity’s own files, .git edits, Ask me and Accept edits', () => {
  const { ws, home, call } = workspace();
  assert.equal(call(...cmd(`echo x >> ${join(home, '.gemini', 'antigravity-cli', 'settings.json')}`), SHELL).decision, 'ask', 'PROTECTED_CMD’s card');
  assert.equal(call('write_to_file', { TargetFile: join(home, '.gemini', 'antigravity-cli', 'settings.json') }, SHELL).decision, 'deny');
  assert.equal(call('write_to_file', { TargetFile: join(ws, '.git', 'config') }, SHELL).decision, 'ask');
  for (const mode of ['ask', 'acceptEdits']) assert.equal(call(...cmd('npm test'), { mode, tools: ['shell', 'web.fetch'] }).decision, 'ask', mode);
});

test('#416 the hook reads the persona’s tools and whether it can publish from its environment', async () => {
  const { ws, home } = workspace();
  const base = { POSTBOX_MCP_URL: 'http://127.0.0.1:1/mcp', POSTBOX_AGY_MODE: 'auto', POSTBOX_AGY_FOLDERS: JSON.stringify([ws]) };
  const fetchImpl = async () => {
    throw new Error('the hook asked Postbox');
  };
  const run = (event, env) => runAgyHook(JSON.stringify({ toolCall: event }), { cwd: ws, home, env, fetchImpl: /** @type {any} */ (fetchImpl) });
  const npm = { name: 'run_command', args: { CommandLine: 'npm test' } };
  assert.deepEqual(await run(npm, { ...base, POSTBOX_AGY_TOOLS: JSON.stringify(['shell']) }), { decision: 'allow' });
  assert.equal((await run(npm, base)).decision, 'deny', 'no tools listed: it asks, and the failed ask denies');
  const send = { name: 'call_mcp_tool', args: { ServerName: 'slack', ToolName: 'send_message', Arguments: {} } };
  assert.match((await run(send, base)).reason, /publish/);
  assert.deepEqual(await run(send, { ...base, POSTBOX_AGY_PUBLISH: '1' }), { decision: 'allow' });
});
