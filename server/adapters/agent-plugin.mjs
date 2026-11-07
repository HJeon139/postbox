// Postbox’s own Claude Code plugin (agent-plugin): the skills it gives every agent it runs on this computer, Isolated
// or not, as it gives each one its MCP server. The first is visual-explainer (#206, #207), which loads when the person
// asks how something works or what their data shows. Claude Code loads it with --plugin-dir and the Agent SDK with its
// plugins option. The other backends don’t read Claude Code plugins, so each gets the folders of the skills the persona
// left on its own way (postboxSkillDirs, skill-config.mjs): Antigravity a copy in the turn’s workspace plugin, Kiro a
// skill:// resource in the turn’s agent file, and Codex extra skills roots on its app-server. None of them writes into
// the person’s project or their own CLI setup beyond what Postbox already writes there for a turn. A turn on another
// computer doesn’t get them: the folder is on this one. A persona that turns off all of its skills doesn’t get the
// plugin either (skillsOff, skill-config.mjs; setup.mjs, fromContext), and POSTBOX_AGENT_SKILLS=off leaves it out for
// every agent, for a UAT baseline (`- skills: off`, tools/uat/telemetry-run.mjs).

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** The plugin’s folder: .claude-plugin/plugin.json names it `postbox`, so its skills are `postbox:<name>`. */
export const AGENT_PLUGIN = join(import.meta.dirname, '..', '..', 'agent-plugin');

/** The plugin folders a Claude turn here loads. @param {NodeJS.ProcessEnv} [env] @returns {string[]} */
export const agentPlugins = (env = process.env) => (env.POSTBOX_AGENT_SKILLS === 'off' ? [] : [AGENT_PLUGIN]);

/**
 * Every file in the given skill folders (postboxSkillDirs, skill-config.mjs), by its path under the plugin’s skills
 * folder with forward slashes, such as `visual-explainer/SKILL.md`, for a backend that gets a copy (Antigravity).
 * @param {string[]} dirs @returns {Promise<Record<string, string>>}
 */
export async function agentSkillFiles(dirs) {
  const root = join(AGENT_PLUGIN, 'skills');
  const paths = [];
  for (const dir of dirs) for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) paths.push(join(e.parentPath, e.name));
  const files = {};
  for (const path of paths.sort()) files[relative(root, path).split(sep).join('/')] = await readFile(path, 'utf8');
  return files;
}
