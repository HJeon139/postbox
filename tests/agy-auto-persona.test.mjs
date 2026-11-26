// #416, option A (the person’s pick, 8 Nov): Antigravity’s Auto works like Run everything for the tools its persona
// has. In Auto, a command runs when the persona has shell, a search or fetch when it has web.fetch, and an MCP tool
// outside Postbox when it doesn’t publish. A publishing tool is refused in every mode for a persona that can’t publish
// outside Postbox, as Claude Code’s --disallowedTools refuses it. Ask me, Accept edits and Antigravity’s own files are
// unchanged. #1710 (the person, 23 Nov): with shell, the read and edit tools follow the shell’s rule too, since a card
// for what a command can do with no card protected nothing; .git edits ask only without shell.

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
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

test('Run everything refuses built-in search, fetch and browser tools when Web is off, and keeps hook guards', () => {
  const { ws, home, call } = workspace();
  for (const name of ['search_web', 'read_url_content', 'open_browser_url', 'read_browser_page', 'browser_subagent', 'capture_browser_screenshot']) {
    assert.equal(call(name, { query: 'Postbox', Url: 'https://example.com' }, { mode: 'bypass' }).decision, 'deny', name);
    assert.equal(call(name, { query: 'Postbox', Url: 'https://example.com' }, { mode: 'bypass', ...WEB }).decision, 'allow', name);
  }
  assert.equal(call(...mcp('postbox_postbox', 'permission_prompt'), { mode: 'bypass' }).decision, 'deny');
  assert.equal(call('write_to_file', { TargetFile: join(ws, '.agents', 'plugins', 'postbox', 'hooks.json') }, { mode: 'bypass' }).decision, 'deny');
  assert.equal(call('write_to_file', { TargetFile: join(home, '.gemini', 'antigravity-cli', 'settings.json') }, { mode: 'bypass' }).decision, 'deny');
  assert.equal(call(...cmd('npm test'), { mode: 'bypass', ...SHELL }).decision, 'allow');
});

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

test('#416 what A keeps: Antigravity’s own files, .git edits without shell, Ask me and Accept edits', () => {
  const { ws, home, call } = workspace();
  assert.equal(call(...cmd(`echo x >> ${join(home, '.gemini', 'antigravity-cli', 'settings.json')}`), SHELL).decision, 'ask', 'PROTECTED_CMD’s card');
  assert.equal(call('write_to_file', { TargetFile: join(home, '.gemini', 'antigravity-cli', 'settings.json') }, SHELL).decision, 'deny');
  assert.equal(call('write_to_file', { TargetFile: join(ws, '.git', 'config') }).decision, 'ask', '.git without shell');
  for (const mode of ['ask', 'acceptEdits']) assert.equal(call(...cmd('npm test'), { mode, tools: ['shell', 'web.fetch'] }).decision, 'ask', mode);
});

test('#416 the hook reads the persona’s tools and whether it can publish from its environment', async () => {
  const { ws, home } = workspace();
  const base = { POSTBOX_MCP_URL: 'http://127.0.0.1:1/mcp', POSTBOX_AGY_MODE: 'auto', POSTBOX_AGY_FOLDERS: JSON.stringify([ws]) };
  const fetchImpl = async () => {
    throw new Error('the hook asked Postbox');
  };
  const run = (event, env) =>
    runAgyHook(JSON.stringify({ conversationId: 'c1', stepIdx: 1, toolCall: event }), { cwd: ws, home, env, fetchImpl: /** @type {any} */ (fetchImpl) });
  const npm = { name: 'run_command', args: { CommandLine: 'npm test' } };
  assert.deepEqual(await run(npm, { ...base, POSTBOX_AGY_TOOLS: JSON.stringify(['shell']) }), { decision: 'allow' });
  assert.equal((await run(npm, base)).decision, 'deny', 'no tools listed: it asks, and the failed ask denies');
  const send = { name: 'call_mcp_tool', args: { ServerName: 'slack', ToolName: 'send_message', Arguments: {} } };
  assert.match((await run(send, base)).reason, /publish/);
  assert.deepEqual(await run(send, { ...base, POSTBOX_AGY_PUBLISH: '1' }), { decision: 'allow' });
});

test('#1710 in Auto with shell, a read or an edit anywhere runs as the shell’s command would, and Antigravity’s own files still don’t', () => {
  const { ws, home, call } = workspace();
  const settings = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  for (const [name, args] of [
    ['read_file', { Path: join(home, 'notes.txt') }],
    ['view_file', { AbsolutePath: '/etc/hosts' }],
    ['list_dir', { DirectoryPath: home }],
    ['grep_search', { SearchPath: join(home, 'src'), Query: 'x' }],
    ['write_to_file', { TargetFile: join(home, 'out.txt') }],
    ['replace_file_content', { TargetFile: join(ws, '.git', 'config') }],
  ])
    assert.equal(call(name, args, SHELL).decision, 'allow', `${name} with shell`);
  // What a command naming them gets: a card for a read, a refusal for an edit.
  assert.equal(call('read_file', { Path: settings }, SHELL).decision, 'ask', 'a read of agy’s settings');
  assert.equal(call('write_to_file', { TargetFile: settings }, SHELL).decision, 'deny');
  assert.equal(call('write_to_file', { TargetFile: join(ws, '.agents', 'plugins', 'postbox', 'hooks.json') }, SHELL).decision, 'deny');
  // A call naming two paths, one of them agy’s: the one decides. And one with no path field it knows.
  assert.equal(call('grep_search', { SearchPath: home, Path: settings, Query: 'x' }, SHELL).decision, 'ask', 'two paths, one agy’s');
  assert.equal(call('read_file', { File: settings }, SHELL).decision, 'ask', 'no path field');
  // Through a link into agy’s folder, and a .agents folder outside the agent’s: a command naming either gets a card.
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  symlinkSync(join(home, '.gemini', 'antigravity-cli'), join(home, 'agy-link'));
  assert.equal(call('read_file', { Path: join(home, 'agy-link', 'settings.json') }, SHELL).decision, 'ask', 'a link into agy’s folder');
  const other = join(home, 'other', '.agents', 'rules', 'x.md');
  assert.equal(call('read_file', { Path: other }, SHELL).decision, 'ask', 'a .agents read outside');
  assert.equal(call('write_to_file', { TargetFile: other }, SHELL).decision, 'ask', 'a .agents edit outside');
  // Only the read and edit tools: a tool Postbox doesn’t know still asks, though it names a path.
  assert.equal(call('delete_everything', { Path: join(home, 'notes.txt') }, SHELL).decision, 'ask', 'an unknown tool');
  // Without shell the folder rule protects something, so it holds; and only Auto changes.
  assert.equal(call('read_file', { Path: join(home, 'notes.txt') }).decision, 'ask', 'a read outside, no shell');
  assert.equal(call('write_to_file', { TargetFile: join(home, 'out.txt') }).decision, 'ask', 'an edit outside, no shell');
  for (const mode of ['ask', 'acceptEdits']) {
    assert.equal(call('read_file', { Path: join(home, 'notes.txt') }, { mode, ...SHELL }).decision, 'ask', mode);
    assert.equal(call('write_to_file', { TargetFile: join(home, 'out.txt') }, { mode, ...SHELL }).decision, 'ask', mode);
  }
});
