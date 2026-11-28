// Postbox’s own Claude Code plugin (agent-plugin): the skills it gives every agent it runs, here or on a host, Isolated
// or not, as it gives each one its MCP server. The first is visual-explainer (#206, #207), which loads when the person
// asks how something works or what their data shows. Claude Code loads it with --plugin-dir. The other backends don’t
// read Claude Code plugins, so each gets the skills folder its own way:
// Antigravity a copy in the turn’s workspace plugin, Kiro a skill:// resource in the turn’s agent file, and Codex an
// extra skills root on its app-server. None of them writes into the person’s project or their own CLI setup beyond
// what Postbox already writes there for a turn. A turn on a remote host (ctx.remote) gets the copy the host install
// ships beside Postbox’s host code (server/remote/install-bundle.mjs), under ~/.postbox-remote/<version>/ there, in the
// same way: Claude Code a --plugin-dir, Kiro a skill:// resource and Codex an extra skills root, each naming the host’s
// path (#207).
// A persona leaves out the ones it turned off (skillsOff, skill-config.mjs, postboxSkillsOn), and
// POSTBOX_AGENT_SKILLS=off leaves them all out for every agent, for a UAT baseline (`- skills: off`,
// tools/uat/run-env.mjs).

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { hostPaths } from '../../shared/remote-protocol.mjs';

/** The plugin’s folder: .claude-plugin/plugin.json names it `postbox`, so its skills are `postbox:<name>`. */
export const AGENT_PLUGIN = join(import.meta.dirname, '..', '..', 'agent-plugin');

/**
 * The plugin’s copy on a host: the install keeps the repo’s layout under the version’s folder there.
 * @param {import('./adapter.mjs').RemoteContext} remote  ctx.remote, whose welcome names the host’s home
 */
function hostPlugin(remote) {
  const welcome = remote.welcome ?? remote.link?.welcome;
  return `${hostPaths(welcome.home, remote.version).code}/agent-plugin`;
}

/**
 * The plugin folders a Claude turn loads: this computer’s, or on a host its copy there; none when
 * POSTBOX_AGENT_SKILLS=off.
 * @param {NodeJS.ProcessEnv} [env] @param {import('./adapter.mjs').RemoteContext | null} [remote]  ctx.remote
 * @returns {string[]}
 */
export function agentPlugins(env = process.env, remote = null) {
  if (env.POSTBOX_AGENT_SKILLS === 'off') return [];
  return [remote ? hostPlugin(remote) : AGENT_PLUGIN];
}

/**
 * The plugin’s skills folder, one folder per skill, for a backend that doesn’t read Claude Code plugins: this
 * computer’s, or on a host its copy there; null when POSTBOX_AGENT_SKILLS=off.
 * @param {NodeJS.ProcessEnv} [env] @param {import('./adapter.mjs').RemoteContext | null} [remote]  ctx.remote
 * @returns {string | null}
 */
export function agentSkills(env = process.env, remote = null) {
  if (env.POSTBOX_AGENT_SKILLS === 'off') return null;
  return remote ? `${hostPlugin(remote)}/skills` : join(AGENT_PLUGIN, 'skills');
}

/**
 * The files of the named skills, by their path in the skills folder with forward slashes, for a backend that gets a
 * copy (Antigravity); none when POSTBOX_AGENT_SKILLS=off.
 * @param {string[]} names  the skills’ folders, the ones the persona keeps on (postboxSkillsOn in skill-config.mjs)
 * @param {NodeJS.ProcessEnv} [env] @returns {Promise<Record<string, string>>}
 */
export async function agentSkillFiles(names, env = process.env) {
  const dir = agentSkills(env);
  if (!dir) return {};
  const paths = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  const files = {};
  for (const path of paths.sort()) {
    const rel = relative(dir, path).split(sep).join('/');
    if (names.includes(rel.split('/')[0])) files[rel] = await readFile(path, 'utf8');
  }
  return files;
}
