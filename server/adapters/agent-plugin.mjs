// Postbox’s own Claude Code plugin (agent-plugin): the skills it gives every Claude agent it runs on this
// computer, Isolated or not, as it gives each one its MCP server. The first is visual-explainer (#206, #207), which
// loads when the person asks how something works or what their data shows. Claude Code loads it with --plugin-dir and
// the Agent SDK with its plugins option, so nothing is written into the person’s project or their own Claude setup.
// A turn on another computer doesn’t get it: the folder is on this one. A persona that turns off all of its skills
// doesn’t get it either (skillsOff, skill-config.mjs; setup.mjs, fromContext), and POSTBOX_AGENT_SKILLS=off leaves it
// out for every agent, for a UAT baseline (`- skills: off`, tools/uat/telemetry-run.mjs).

import { join } from 'node:path';

/** The plugin’s folder: .claude-plugin/plugin.json names it `postbox`, so its skills are `postbox:<name>`. */
export const AGENT_PLUGIN = join(import.meta.dirname, '..', '..', 'agent-plugin');

/** The plugin folders a Claude turn here loads. @param {NodeJS.ProcessEnv} [env] @returns {string[]} */
export const agentPlugins = (env = process.env) => (env.POSTBOX_AGENT_SKILLS === 'off' ? [] : [AGENT_PLUGIN]);
