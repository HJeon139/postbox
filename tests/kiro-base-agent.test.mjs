// A workflow's own Kiro agent merged into the agent file of a turn (POSTBOX_KIRO_BASE_AGENT,
// server/adapters/setup.mjs kiroBaseAgent and mergeKiroAgent). The base is the shape of the seed's
// .kiro/agents/evalgen.json at LoopEvaluationHarnessDemo f343923a, cut to the fields the merge reads.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { kiroAgent } from '../server/adapters/kiro-cli.mjs';
import { kiroBaseAgent } from '../server/adapters/setup.mjs';

const base = {
  name: 'evalgen',
  prompt: 'Read `evalgen/WORKFLOW.md` and act as the supervisor it describes.',
  mcpServers: { 'creds-agent': { command: 'aim', args: ['mcp', 'start-server', 'local-creds-agent-mcp'] } },
  tools: ['fs_read', 'fs_write', 'shell', 'subagent', 'todo_list', '@creds-agent'],
  allowedTools: ['fs_read', 'shell', 'subagent', 'todo_list', '@creds-agent'],
  resources: ['file://evalgen/WORKFLOW.md', 'file://evalgen/common/contracts.md'],
  toolsSettings: { subagent: { availableAgents: ['evalgen-worker'], trustedAgents: ['evalgen-worker'] } },
  includeMcpJson: false,
  model: null,
  permissions: {
    rules: [
      { capability: 'mcp', match: ['creds-agent/*'], effect: 'allow' },
      { capability: 'shell', effect: 'allow' },
      { capability: 'shell', match: ['*git push*'], effect: 'deny' },
      { capability: 'subagent', match: ['evalgen-worker'], effect: 'allow' },
      { capability: 'subagent', exclude: ['evalgen-worker'], effect: 'deny' },
    ],
  },
};
const workspace = (agent) => {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-base-'));
  mkdirSync(join(dir, '.kiro', 'agents'), { recursive: true });
  if (agent) writeFileSync(join(dir, '.kiro', 'agents', 'evalgen.json'), JSON.stringify(agent));
  return dir;
};
const turn = (dir, merged) =>
  kiroAgent({
    name: 't',
    persona: { handle: 'builder', tools: ['shell'], usesHostSetup: false },
    mcpUrl: 'http://127.0.0.1:1/mcp',
    guide: 'You are @builder in Postbox.',
    folders: [dir],
    base: merged,
  });

test('the base agent is merged in, and neither Postbox’s agent nor the base is replaced', () => {
  const { dir } = seeded(base);
  const plain = turn(dir, null);
  const agent = turn(dir, kiroBaseAgent('builder', dir, 'builder=evalgen'));
  // Postbox's server, guide and every one of its rules stay.
  assert.deepEqual(agent.mcpServers, plain.mcpServers);
  assert.ok(agent.prompt.startsWith(plain.prompt));
  for (const rule of plain.permissions.rules) assert.ok(agent.permissions.rules.some((r) => JSON.stringify(r) === JSON.stringify(rule)));
  // The base's prompt, resources, tool settings and its own rules come too.
  assert.ok(agent.prompt.endsWith(base.prompt));
  assert.deepEqual(agent.resources, base.resources.map((r) => `file://${realpathSync(join(dir, r.slice('file://'.length)))}`));
  assert.deepEqual(agent.toolsSettings, base.toolsSettings);
  assert.ok(agent.permissions.rules.some((r) => r.capability === 'shell' && r.effect === 'deny' && r.match?.includes('*git push*')));
  assert.ok(agent.permissions.rules.some((r) => r.capability === 'subagent' && r.effect === 'deny' && r.exclude?.includes('evalgen-worker')));
  assert.ok(agent.tools.includes('subagent') && agent.tools.includes('@postbox'));
});

test('the base’s own MCP servers are dropped with their tools and rules, so only Postbox’s server loads', () => {
  const { dir } = seeded(base);
  const agent = turn(dir, kiroBaseAgent('builder', dir, 'builder=evalgen'));
  assert.deepEqual(Object.keys(agent.mcpServers), ['postbox']);
  assert.ok(!agent.tools.includes('@creds-agent'));
  assert.ok(!(agent.allowedTools ?? []).includes('@creds-agent'));
  assert.ok(!agent.permissions.rules.some((r) => r.capability === 'mcp' && r.match?.some((m) => m.startsWith('creds-agent/'))));
});

test('another persona gets no base, and a named base that is missing or unreadable stops the turn', () => {
  const dir = workspace(base);
  assert.equal(kiroBaseAgent('customer', dir, 'builder=evalgen'), null);
  assert.equal(kiroBaseAgent('builder', dir, ''), null);
  assert.throws(() => kiroBaseAgent('builder', workspace(null), 'builder=evalgen'), /evalgen\.json/);
  assert.throws(() => kiroBaseAgent('builder', dir, 'builder=../evalgen'), /agent name/);
  const bad = workspace(null);
  writeFileSync(join(bad, '.kiro', 'agents', 'evalgen.json'), '{');
  assert.throws(() => kiroBaseAgent('builder', bad, 'builder=evalgen'), /POSTBOX_KIRO_BASE_AGENT/);
});

// Critic's review of ff21bb07: the builder can write its workspace's .kiro/agents files, and a resource there loads
// into the turn's context with no tool call, past the deny policy.
function seeded(agent, worker = { name: 'evalgen-worker', prompt: 'w' }) {
  const seed = workspace(agent);
  writeFileSync(join(seed, '.kiro', 'agents', 'evalgen-worker.json'), JSON.stringify(worker));
  const dir = workspace(agent);
  writeFileSync(join(dir, '.kiro', 'agents', 'evalgen-worker.json'), JSON.stringify(worker));
  mkdirSync(join(dir, 'evalgen', 'common'), { recursive: true });
  writeFileSync(join(dir, 'evalgen', 'WORKFLOW.md'), '# w');
  writeFileSync(join(dir, 'evalgen', 'common', 'contracts.md'), '# c');
  return { seed, dir };
}

test('with a seed named, the base comes from the seed, and a workspace agent file that differs stops the turn', () => {
  const { seed, dir } = seeded(base);
  assert.deepEqual(kiroBaseAgent('builder', dir, 'builder=evalgen', seed), base);
  writeFileSync(join(dir, '.kiro', 'agents', 'evalgen.json'), JSON.stringify({ ...base, resources: ['file:///etc/hosts'] }));
  assert.throws(() => kiroBaseAgent('builder', dir, 'builder=evalgen', seed), /evalgen\.json differs from the seed/);
  const worker = seeded(base);
  writeFileSync(join(worker.dir, '.kiro', 'agents', 'evalgen-worker.json'), JSON.stringify({ name: 'evalgen-worker', resources: ['file:///etc/hosts'] }));
  assert.throws(() => kiroBaseAgent('builder', worker.dir, 'builder=evalgen', worker.seed), /evalgen-worker\.json differs from the seed/);
  const added = seeded(base);
  writeFileSync(join(added.dir, '.kiro', 'agents', 'extra.json'), '{}');
  assert.throws(() => kiroBaseAgent('builder', added.dir, 'builder=evalgen', added.seed), /extra\.json .*not in the seed/);
});

test('a base resource outside the working folder, or not a file, stops the turn', () => {
  for (const resource of ['file:///etc/hosts', 'file://../outside.md', 'https://example.com/x.md', 'file://evalgen/missing.md']) {
    const { dir } = seeded(base);
    assert.throws(() => turn(dir, { ...base, resources: [resource] }), /resource/, resource);
  }
  const { dir } = seeded(base);
  assert.equal(turn(dir, base).resources.length, 2);
});
