// Postbox’s own plugin (server/adapters/agent-plugin.mjs): every Claude agent on this computer loads its skills, the
// visual explainer first (#206), Isolated or not. A turn on a host doesn’t, since the folder is here, and
// POSTBOX_AGENT_SKILLS=off leaves it out for a UAT baseline. The plugin holds what an agent reads and nothing else:
// the starter briefs, which hold each test’s intended idea and traps, stay in designs/.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_PLUGIN, agentPlugins } from '../server/adapters/agent-plugin.mjs';
import { sdkOptions } from '../server/adapters/agent-sdk.mjs';
import { claudeArgs } from '../server/adapters/claude-code-args.mjs';
import { fromContext } from '../server/adapters/setup.mjs';

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
