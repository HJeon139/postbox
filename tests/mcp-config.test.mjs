// #59: your MCP servers load for personas that use your setup, a persona can turn any of them off, and the sheet
// lists them with their status.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sdkOptions } from '../server/adapters/agent-sdk.mjs';
import { claudeArgs } from '../server/adapters/claude-code.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { mcpServerList, yourMcpServers } from '../server/adapters/mcp-config.mjs';
import { isPublishingTool } from '../server/adapters/setup.mjs';
import { TOOL_DEFS } from '../server/mcp.mjs';

const HOME = '/home/pat';
const WORK = '/work/site';
/** A file reader over an in-memory folder tree, so the tests never read the real home folder. */
const files = (tree) => async (path) => {
  if (!Object.hasOwn(tree, path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return typeof tree[path] === 'string' ? tree[path] : JSON.stringify(tree[path]);
};
const read = (tree, folder = WORK) => yourMcpServers(folder, { home: HOME, read: files(tree) });

test('CLAUDE_CONFIG_DIR moves the global config and the user settings, as Claude Code reads them', async () => {
  const tree = {
    [`${HOME}/.claude.json`]: { mcpServers: { wrong: {} } },
    '/cfg/.claude.json': { mcpServers: { right: {} }, projects: { [WORK]: { mcpServers: { here: {} } } } },
    '/cfg/settings.json': { enabledMcpjsonServers: ['docs'] },
    [`${WORK}/.mcp.json`]: { mcpServers: { docs: {} } },
  };
  assert.deepEqual(await yourMcpServers(WORK, { home: HOME, configDir: '/cfg', read: files(tree) }), [
    { name: 'right', scope: 'user' },
    { name: 'docs', scope: 'project' },
    { name: 'here', scope: 'local' },
  ]);
  // An injected home never takes the variable from the environment.
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/cfg';
  try {
    assert.deepEqual(await read(tree), [{ name: 'wrong', scope: 'user' }]);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test('your MCP servers are read from the user, project and local scopes, later scopes winning a name', async () => {
  const tree = {
    [`${HOME}/.claude.json`]: {
      mcpServers: { search: { command: 'secret-cmd', env: { TOKEN: 'x' } }, shared: {} },
      projects: { [WORK]: { mcpServers: { shared: {}, mine: {} }, enabledMcpjsonServers: ['docs'] }, '/elsewhere': { mcpServers: { other: {} } } },
    },
    [`${WORK}/.mcp.json`]: { mcpServers: { docs: {}, unapproved: {}, search: {} } },
    [`${WORK}/.claude/settings.local.json`]: { enabledMcpjsonServers: ['search'] },
  };
  const found = await read(tree);
  assert.deepEqual(found, [
    { name: 'search', scope: 'project' },
    { name: 'shared', scope: 'local' },
    { name: 'docs', scope: 'project' },
    { name: 'mine', scope: 'local' },
  ]);
  assert.ok(!JSON.stringify(found).includes('secret'), 'names and scopes only, never a server’s config');
  assert.deepEqual(await read(tree, null), [
    { name: 'search', scope: 'user' },
    { name: 'shared', scope: 'user' },
  ]);
});

test('project servers load only when approved, and not when disabled', async () => {
  const mcp = { [`${WORK}/.mcp.json`]: { mcpServers: { a: {}, b: {}, postbox: {} } } };
  assert.deepEqual(await read(mcp), [], 'unapproved');
  const all = { ...mcp, [`${WORK}/.claude/settings.json`]: { enableAllProjectMcpServers: true, disabledMcpjsonServers: ['b'] } };
  assert.deepEqual(await read(all), [{ name: 'a', scope: 'project' }], 'all approved, minus the disabled one, and never one named postbox');
  const user = { ...mcp, [`${HOME}/.claude/settings.json`]: { enabledMcpjsonServers: ['b'] } };
  assert.deepEqual(await read(user), [{ name: 'b', scope: 'project' }]);
});

test('a missing or malformed config counts as empty', async () => {
  assert.deepEqual(await read({}), []);
  const broken = {
    [`${HOME}/.claude.json`]: '{ not json',
    [`${WORK}/.mcp.json`]: '[]',
    [`${WORK}/.claude/settings.json`]: { enableAllProjectMcpServers: true },
  };
  assert.deepEqual(await read(broken), []);
  assert.deepEqual(await read({ [`${HOME}/.claude.json`]: { mcpServers: ['a'], projects: { [WORK]: 'x' } } }), []);
});

test('the sheet lists servers from config and the last init, with their status; turned-off ones stay listed', () => {
  const list = mcpServerList({
    found: [
      { name: 'search', scope: 'user' },
      { name: 'docs', scope: 'project' },
    ],
    seen: [
      { name: 'postbox', status: 'connected', source: 'dynamic' },
      { name: 'search', status: 'needs-auth', source: 'user' },
      { name: 'claude.ai Google Drive', status: 'connected', source: 'claudeai' },
      { name: 'plugin:forge:forge', status: 'weird', source: 'plugin' },
    ],
    off: ['gone'],
  });
  assert.deepEqual(list, [
    { name: 'search', scope: 'user', status: 'needs-auth', off: false },
    { name: 'docs', scope: 'project', status: 'not-started', off: false },
    { name: 'claude.ai Google Drive', scope: 'claude.ai', status: 'connected', off: false },
    { name: 'plugin:forge:forge', scope: 'plugin', status: 'failed', off: false },
    { name: 'gone', scope: 'unknown', status: 'not-started', off: true },
  ]);
});

// host-mcp-init.jsonl holds two real init events (claude 2.1.296, claude-haiku-5-5, outside the repo, the person’s
// setup without --strict-mcp-config, Postbox’s server passed with --mcp-config but not running), cut down to
// their model, tools and mcp_servers, with a private connector left out:
//   1. with the person’s plugins and claude.ai connectors, and a project server (“probe”, approved, not running);
//   2. the same, with probe, claude.ai Google Drive and plugin:forge:forge in deniedMcpServers, and every deny
//      list in --disallowedTools (the publishing tools; with #5’s, the outside-agent and unticked tools too).
const fixture = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

test('a real init with your setup loads your servers and connectors, and deniedMcpServers removes a turned-off one', () => {
  const [mine, denied] = fixture('host-mcp-init');
  const names = (i) => i.mcp_servers.map((s) => s.name);
  for (const n of ['postbox', 'probe', 'claude.ai Google Drive', 'claude.ai Claude Docs', 'plugin:forge:forge']) assert.ok(names(mine).includes(n), n);
  assert.ok(mine.tools.some((t) => t.startsWith('mcp__plugin_forge_forge__')));
  for (const n of ['probe', 'claude.ai Google Drive', 'plugin:forge:forge']) assert.ok(!names(denied).includes(n), `${n} is gone`);
  assert.ok(!denied.tools.some((t) => /^mcp__(plugin_forge_forge|claude_ai_Google_Drive)__/.test(t)), 'and so are its tools');
  assert.ok(names(denied).includes('postbox') && names(denied).includes('claude.ai Claude Docs'), 'the rest still load');
});

test('the publishing deny list holds once connectors and plugin servers load, and spares Postbox’s tools', () => {
  const [mine, denied] = fixture('host-mcp-init');
  assert.deepEqual(mine.tools.filter(isPublishingTool), [
    'Artifact',
    'ArtifactComments',
    'ArtifactData',
    'PushNotification',
    'mcp__claude_ai_Claude_Docs__batch',
    'mcp__claude_ai_Claude_Docs__create',
    'mcp__claude_ai_Claude_Docs__update',
    'mcp__claude_ai_Google_Drive__copy_file',
    'mcp__claude_ai_Google_Drive__create_file',
    'mcp__claude_ai_Google_Drive__share_file',
    'mcp__claude_ai_Google_Drive__update_file',
  ]);
  // Read-only and local tools stay: the connector’s reads, and a plugin’s local memory.
  for (const t of ['mcp__claude_ai_Claude_Docs__read', 'mcp__claude_ai_Google_Drive__search_files', 'mcp__plugin_forge_forge__memory_save', 'Read'])
    assert.ok(mine.tools.includes(t) && !isPublishingTool(t), t);
  for (const t of TOOL_DEFS) assert.ok(!isPublishingTool(`mcp__postbox__${t.name}`), t.name);
  // With --disallowedTools passed, Claude Code removed them all.
  assert.deepEqual(denied.tools.filter(isPublishingTool), []);
  assert.ok(denied.tools.includes('mcp__claude_ai_Claude_Docs__read'));
});

const base = { sessionId: 's', resume: false, mcpUrl: 'http://x/mcp', guide: 'g' };
const sdkBase = { cwd: '/w', sessionId: 's', resume: false, mcpUrl: 'http://x/mcp', guide: 'g', abortController: new AbortController() };
const after = (args, flag) => args[args.indexOf(flag) + 1];

test('personas that use your setup load your MCP servers next to Postbox’s; Isolated ones load only Postbox’s', () => {
  for (const usesHostSetup of [undefined, true]) {
    const persona = { model: 'mock', usesHostSetup };
    const args = claudeArgs({ ...base, persona });
    assert.ok(!args.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(after(args, '--mcp-config')), { mcpServers: { postbox: { type: 'http', url: 'http://x/mcp', alwaysLoad: true } } });
    const o = sdkOptions({ ...sdkBase, persona });
    assert.equal(o.strictMcpConfig, undefined);
    assert.deepEqual(o.mcpServers, { postbox: { type: 'http', url: 'http://x/mcp', alwaysLoad: true } });
  }
  const isolated = { model: 'mock', usesHostSetup: false, mcpOff: ['search'] };
  const args = claudeArgs({ ...base, persona: isolated });
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(after(args, '--settings')), { outputStyle: 'default' }, 'nothing else loads, so nothing to deny');
  const o = sdkOptions({ ...sdkBase, persona: isolated });
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.settings, { outputStyle: 'default' });
});

test('servers a persona turned off are denied by name in both backends; Postbox’s own never is', () => {
  const persona = { model: 'mock', mcpOff: ['search', 'claude.ai Google Drive', 'postbox'] };
  const want = { outputStyle: 'default', deniedMcpServers: [{ serverName: 'search' }, { serverName: 'claude.ai Google Drive' }] };
  assert.deepEqual(JSON.parse(after(claudeArgs({ ...base, persona }), '--settings')), want);
  assert.deepEqual(sdkOptions({ ...sdkBase, persona }).settings, want);
});

test('the stream reports the MCP servers an init lists, for the sheet’s status', () => {
  const reported = [];
  const ctx = { status: () => {}, activity: () => {}, text: () => {}, reported: (r) => reported.push(r) };
  const m = createStreamMapper(ctx);
  const [mine] = fixture('host-mcp-init');
  m.push(mine);
  assert.deepEqual(reported, [{ mcpServers: mine.mcp_servers }]);
});
