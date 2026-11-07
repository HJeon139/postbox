// Postbox’s skills on the backends that don’t read Claude Code plugins (server/adapters/agent-plugin.mjs): Antigravity
// gets a copy in the turn’s workspace plugin, Kiro a skill:// resource in the turn’s agent file, and Codex an extra
// skills root on its app-server. A turn on a host gets none, and POSTBOX_AGENT_SKILLS=off leaves them out.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AGENT_PLUGIN, agentSkillFiles, agentSkills } from '../server/adapters/agent-plugin.mjs';
import { agyPlugin, PLUGIN_DIR, writeAgyPlugin } from '../server/adapters/agy-plugin.mjs';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { addPostboxSkills } from '../server/adapters/codex-thread.mjs';
import { KiroCliAdapter, kiroAgent } from '../server/adapters/kiro-cli.mjs';
import { fakeAppServer } from './codex-fixture.mjs';
import { fakeCtx, fakeSpawn, fixture } from './kiro-cli-fakes.mjs';
import { tempDir } from './temp-dirs.mjs';

const SKILLS = join(AGENT_PLUGIN, 'skills');
const OFF = { POSTBOX_AGENT_SKILLS: 'off' };

test('the skills folder and its files, and none when POSTBOX_AGENT_SKILLS=off', async () => {
  assert.equal(agentSkills({}), SKILLS);
  assert.equal(agentSkills(OFF), null);
  const files = await agentSkillFiles({});
  assert.equal(files['visual-explainer/SKILL.md'], readFileSync(join(SKILLS, 'visual-explainer', 'SKILL.md'), 'utf8'));
  assert.ok(files['visual-explainer/references/brief.md'], 'the references come too, since SKILL.md links to them');
  assert.deepEqual(await agentSkillFiles(OFF), {});
});

test('Antigravity: the skills go in the plugin’s skills folder, as written to disk', async () => {
  const skills = await agentSkillFiles({});
  const files = agyPlugin({ mcpUrl: 'http://127.0.0.1:1/mcp', rules: 'R', skills });
  assert.equal(files['skills/visual-explainer/SKILL.md'], skills['visual-explainer/SKILL.md']);
  assert.ok(!Object.keys(agyPlugin({ mcpUrl: 'u', rules: 'R' })).some((p) => p.startsWith('skills/')), 'none when there are none');
  const dir = tempDir('pb-agy-skills-');
  await writeAgyPlugin(dir, files);
  assert.equal(readFileSync(join(dir, 'skills', 'visual-explainer', 'references', 'shapes.md'), 'utf8'), skills['visual-explainer/references/shapes.md']);
});

test('Antigravity: the skills are in the plugin while agy runs, and gone with it after', async () => {
  const root = tempDir('pb-agy-skills-turn-');
  const lines = readFileSync(new URL('fixtures/antigravity-cli/block.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n');
  const seen = [];
  const spawnImpl = (_bin, _args, opts) => {
    seen.push({ cwd: opts.cwd, skill: existsSync(join(opts.cwd, PLUGIN_DIR, 'skills', 'visual-explainer', 'SKILL.md')) });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    setImmediate(() => {
      child.stdout.end(`${lines.join('\n')}\n`);
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  const adapter = new AntigravityCliAdapter({
    workRoot: join(root, 'work'),
    settingsFile: join(root, 'settings.json'),
    spawnImpl: /** @type {any} */ (spawnImpl),
    env: {},
  });
  await adapter.deliver(
    {},
    { kind: 'user', text: 'Hi.' },
    fakeCtx({ persona: { handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode: 'ask', tools: [] } }),
  );
  assert.deepEqual(
    seen.map((s) => s.skill),
    [true],
  );
  assert.ok(!existsSync(join(seen[0].cwd, PLUGIN_DIR)), 'the plugin, skills and all, is removed');
});

test('Kiro: the agent file names the skills as a resource here, and not with a host’s shim or when they’re off', () => {
  const turn = { name: 'x', persona: { handle: 'kiro' }, guide: 'g', folders: [] };
  assert.deepEqual(kiroAgent({ ...turn, mcpUrl: 'u' }).resources, [`skill://${SKILLS}/*/SKILL.md`]);
  assert.equal(kiroAgent({ ...turn, shim: { command: 'node', args: [] } }).resources, undefined, 'the folder isn’t on the host');
  assert.equal(kiroAgent({ ...turn, mcpUrl: 'u', skills: agentSkills(OFF) }).resources, undefined);
});

test('Kiro: a turn’s agent file loads the skills', async () => {
  const root = tempDir('pb-kiro-skills-');
  const seen = [];
  const spawnImpl = /** @type {any} */ (fakeSpawn([{ lines: fixture('first'), code: 0 }], seen));
  const adapter = new KiroCliAdapter({ workRoot: join(root, 'work'), isolatedHome: join(root, 'home'), spawnImpl, env: {} });
  await adapter.deliver({}, { kind: 'user', text: 'Hi.' }, fakeCtx());
  assert.deepEqual(seen[0].agentFile.resources, [`skill://${SKILLS}/*/SKILL.md`]);
});

test('Codex: the skills root is set here, not on a host or when off, and an older Codex goes on without it', async () => {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };
  assert.equal(await addPostboxSkills(request, { env: {} }), true);
  assert.deepEqual(calls, [{ method: 'skills/extraRoots/set', params: { extraRoots: [SKILLS] } }]);
  assert.equal(await addPostboxSkills(request, { remote: true, env: {} }), false);
  assert.equal(await addPostboxSkills(request, { env: OFF }), false);
  assert.equal(calls.length, 1);
  const unknown = () => Promise.reject(Object.assign(new Error('unknown method'), { code: -32601 }));
  assert.equal(await addPostboxSkills(unknown, { env: {} }), false);
});

test('Codex: a turn sets the skills root before it opens the thread', async () => {
  const seen = [];
  const adapter = new CodexAdapter({ workRoot: tempDir('pb-codex-skills-'), spawnImpl: () => fakeAppServer(seen) });
  const ctx = {
    persona: { handle: 'critic', permissionMode: 'acceptEdits' },
    handles: ['critic'],
    state: {},
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s1',
    text: () => {},
    activity: () => {},
    status: () => {},
    saveState: () => {},
    checkpoint: () => {},
    pathOf: () => null,
  };
  await adapter.deliver({}, { kind: 'user', text: 'Hi.' }, ctx);
  const methods = seen.map((x) => x.method);
  assert.deepEqual(seen.find((x) => x.method === 'skills/extraRoots/set')?.params, { extraRoots: [SKILLS] });
  assert.ok(methods.indexOf('skills/extraRoots/set') < methods.indexOf('thread/start'), methods.join(', '));
});
