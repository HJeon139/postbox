// Postbox’s own plugin (server/adapters/agent-plugin.mjs): every Claude agent on this computer loads its skills, the
// visual explainer first (#206), Isolated or not. A turn on a host doesn’t, since the folder is here, a persona can
// turn its skills off (skillsOff, from its sheet), and POSTBOX_AGENT_SKILLS=off leaves it out for a UAT baseline. The plugin holds what an agent reads and nothing else:
// the starter briefs, which hold each test’s intended idea and traps, stay in designs/.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { AGENT_PLUGIN, agentPlugins } from '../server/adapters/agent-plugin.mjs';
import { sdkOptions } from '../server/adapters/agent-sdk.mjs';
import { claudeArgs } from '../server/adapters/claude-code-args.mjs';
import { deniedTools, fromContext, settingsFor } from '../server/adapters/setup.mjs';
import { POSTBOX_SKILLS } from '../server/adapters/skill-config.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const ctx = (over = {}) => ({ persona: { id: 'p1', handle: 'coder', model: 'mock' }, project: { id: 'pr1' }, ...over });
/** Each plugin folder Claude Code is given, from its arguments. @param {string[]} args */
const pluginDirs = (args) => args.flatMap((a, i) => (a === '--plugin-dir' ? [args[i + 1]] : []));

test('a turn here loads Postbox’s plugin in Claude Code and the Agent SDK, Isolated or not', () => {
  for (const usesHostSetup of [true, false]) {
    const c = ctx({ persona: { id: 'p1', handle: 'coder', model: 'mock', usesHostSetup } });
    const args = claudeArgs({ persona: c.persona, sessionId: 's', resume: false, mcpUrl: 'http://x/mcp', guide: 'g', ...fromContext(c, '/mem') });
    assert.deepEqual(pluginDirs(args), [AGENT_PLUGIN], `Claude Code, usesHostSetup ${usesHostSetup}`);
    const o = sdkOptions({
      persona: c.persona,
      cwd: '/w',
      sessionId: 's',
      resume: false,
      mcpUrl: 'u',
      guide: 'g',
      abortController: new AbortController(),
      ...fromContext(c, '/mem'),
    });
    assert.deepEqual(o.plugins, [{ type: 'local', path: AGENT_PLUGIN }], `the Agent SDK, usesHostSetup ${usesHostSetup}`);
  }
});

test('a turn on a host doesn’t load it, and POSTBOX_AGENT_SKILLS=off leaves it out here', () => {
  const remote = fromContext(ctx({ remote: { hostId: 'h1' } }), '/mem');
  assert.deepEqual(remote.plugins, []);
  assert.deepEqual(pluginDirs(claudeArgs({ persona: { model: 'mock' }, sessionId: 's', resume: false, guide: 'g', ...remote })), []);
  assert.deepEqual(agentPlugins({ POSTBOX_AGENT_SKILLS: 'off' }), []);
  assert.deepEqual(agentPlugins({}), [AGENT_PLUGIN]);
});

test('the plugin is named postbox and holds the visual explainer’s SKILL.md and references, and no briefs', () => {
  const manifest = JSON.parse(readFileSync(join(AGENT_PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'postbox', 'so the skill is postbox:visual-explainer');
  const skill = join(AGENT_PLUGIN, 'skills', 'visual-explainer');
  assert.match(readFileSync(join(skill, 'SKILL.md'), 'utf8'), /^---\nname: visual-explainer\n/);
  assert.deepEqual(readdirSync(skill).sort(), ['SKILL.md', 'references']);
  // Every file the skill links to is in the plugin, where the agent can read it.
  for (const file of ['SKILL.md', ...readdirSync(join(skill, 'references')).map((n) => join('references', n))]) {
    const text = readFileSync(join(skill, file), 'utf8');
    const links = [...text.matchAll(/\]\((?!https?:|#)([^)#\s]+)/g)].map((m) => m[1]);
    for (const link of new Set(links)) assert.ok(existsSync(join(skill, file, '..', link)), `${file} links to ${link}`);
  }
});

test('a persona turns skills off from its next turn: Postbox’s plugin is left out, and each one is refused or hidden', async () => {
  const store = new Store(null);
  const seen = [];
  const deliver = async (_se, _m, c) =>
    void seen.push({ plugins: fromContext(c, '/mem').plugins, denied: deniedTools(c.persona), settings: settingsFor(c.persona) });
  const config = { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 };
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register({ name: 'mock', deliver }), corpus: {}, config });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'drawer' });
  assert.deepEqual(p.skillsOff, [], 'all on by default');
  for (const bad of ['postbox:visual-explainer', [1], [''], null]) {
    assert.throws(
      () => rt.createPersona({ handle: 'nope', skillsOff: bad }),
      (e) => e.status === 422 && /skills turned off/.test(e.message),
    );
    assert.throws(
      () => rt.updatePersona(p.id, { skillsOff: bad }),
      (e) => e.status === 422,
    );
  }
  // A persona from before the list existed loads them all.
  store.emit('persona', { ...store.state.personas[p.id], skillsOff: undefined });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  /** Sends one message and waits for its turn to reach the adapter and end. */
  const turn = async () => {
    const before = seen.length;
    rt.sendMessage(t.id, { text: 'draw it' });
    for (let i = 0; i < 100 && (rt.turns.size || seen.length === before); i++) await new Promise((r) => setTimeout(r, 5));
  };
  await turn();
  const off = [...POSTBOX_SKILLS, 'grill-me', 'design:design-critique'];
  rt.updatePersona(p.id, { skillsOff: off });
  assert.deepEqual(rt.updatePersona(p.id, { description: 'x' }).skillsOff, off, 'other edits keep it');
  await turn();
  const [before, after] = seen;
  assert.deepEqual([before.plugins, after.plugins], [[AGENT_PLUGIN], []], 'all of Postbox’s off: its plugin isn’t loaded');
  assert.ok(!before.denied.some((r) => r.startsWith('Skill(')), 'nothing refused before');
  for (const name of off) assert.ok(after.denied.includes(`Skill(${name})`), `${name} is refused`);
  assert.equal(before.settings.skillOverrides, undefined);
  assert.deepEqual(after.settings.skillOverrides, { 'grill-me': 'off' }, 'a user skill is hidden; a plugin’s can’t be');
});
