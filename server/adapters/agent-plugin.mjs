// Postbox’s own Claude Code plugin (agent-plugin): the skills it gives every agent it runs on this computer, Isolated
// or not, as it gives each one its MCP server. The first is visual-explainer (#206, #207), which loads when the person
// asks how something works or what their data shows. Claude Code loads it with --plugin-dir and the Agent SDK with its
// plugins option. The other backends don’t read Claude Code plugins, so each gets the skills folder its own way:
// Antigravity a copy in the turn’s workspace plugin, Kiro a skill:// resource in the turn’s agent file, and Codex an
// extra skills root on its app-server. None of them writes into the person’s project or their own CLI setup beyond
// what Postbox already writes there for a turn. A turn on another computer doesn’t get it: the folder is on this one.
// POSTBOX_AGENT_SKILLS=off leaves it out, for a UAT baseline (`- skills: off`, tools/uat/telemetry-run.mjs).

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** The plugin’s folder: .claude-plugin/plugin.json names it `postbox`, so its skills are `postbox:<name>`. */
export const AGENT_PLUGIN = join(import.meta.dirname, '..', '..', 'agent-plugin');

/** The plugin folders a Claude turn here loads. @param {NodeJS.ProcessEnv} [env] @returns {string[]} */
export const agentPlugins = (env = process.env) => (env.POSTBOX_AGENT_SKILLS === 'off' ? [] : [AGENT_PLUGIN]);

/**
 * The plugin’s skills folder, one folder per skill, for a turn here on a backend that doesn’t read Claude Code
 * plugins, or null when POSTBOX_AGENT_SKILLS=off. @param {NodeJS.ProcessEnv} [env] @returns {string | null}
 */
export const agentSkills = (env = process.env) => (env.POSTBOX_AGENT_SKILLS === 'off' ? null : join(AGENT_PLUGIN, 'skills'));

/**
 * Every file in the skills folder, by its path there with forward slashes, for a backend that gets a copy
 * (Antigravity); none when POSTBOX_AGENT_SKILLS=off. @param {NodeJS.ProcessEnv} [env] @returns {Promise<Record<string, string>>}
 */
export async function agentSkillFiles(env = process.env) {
  const dir = agentSkills(env);
  if (!dir) return {};
  const paths = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  const files = {};
  for (const path of paths.sort()) files[relative(dir, path).split(sep).join('/')] = await readFile(path, 'utf8');
  return files;
}
