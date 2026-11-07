// The skills a Claude agent loads, for the persona sheet’s list (#207), and how a persona turns one off. Only names and
// where each comes from leave this module, never a skill’s text.
//
// Where they come from:
// - Postbox: its own plugin (agent-plugin.mjs), as `postbox:<name>`;
// - user: <CLAUDE_CONFIG_DIR or ~/.claude>/skills/<name>/SKILL.md, loaded only when the persona uses your setup;
// - project: <folder>/.claude/skills/<name>/SKILL.md;
// - plugin: your plugins’ skills, `<plugin>:<name>`. The files can’t say which plugins are on, so these come from the
//   last init of a session (its `skills`), as the MCP list takes plugin servers from it (mcp-config.mjs).
// A skill’s name is its frontmatter `name`, or its folder’s.
//
// Turning one off, from code.claude.com/docs/en/skills (checked 7 November 2026):
// - `skillOverrides: { <name>: "off" }` hides a user or project skill from the agent and refuses a call to it. It
//   doesn’t reach plugin skills.
// - A `Skill(<name>)` deny rule refuses the call to any skill, a plugin’s too, but the agent is still told about it:
//   a real init still listed one denied that way.
// - Postbox’s plugin is left out of a turn whose persona turns all of its skills off (agent-plugin.mjs, agentPlugins),
//   so the agent never sees them.
// So every skill turned off gets a deny rule, and a user or project skill is hidden as well.

import { readdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_PLUGIN } from './agent-plugin.mjs';

const MAX_SKILLS = 200;
const MAX_NAME = 200;

/** Postbox’s own skills, as the agent names them. */
export const POSTBOX_SKILLS = Object.freeze(
  readdirSync(join(AGENT_PLUGIN, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `postbox:${d.name}`),
);

/** A plugin’s skill is named `<plugin>:<name>`; a user or project skill has no prefix. */
const isPluginSkill = (name) => name.includes(':');

/**
 * The skills under one skills folder: the frontmatter `name` of each `<folder>/<dir>/SKILL.md`, or the dir’s name.
 * A missing folder or file counts as none, so a broken setup never breaks the sheet.
 * @param {string} dir @param {(path: string) => Promise<string>} read @param {(path: string) => Promise<string[]>} list
 */
async function skillsIn(dir, read, list) {
  const names = [];
  for (const sub of await list(dir).catch(() => [])) {
    const text = await read(join(dir, sub, 'SKILL.md')).catch(() => null);
    if (text === null) continue;
    const named = text.match(/^---\r?\n(?:[^\n]*\n)*?name:\s*["']?([^"'\r\n]+?)["']?\s*\r?\n/)?.[1];
    names.push(named || sub);
  }
  return names.filter((n) => n && n.length <= MAX_NAME);
}

/**
 * The user and project skills on disk for a folder: [{ name, scope }].
 * @param {string|null} folder  where the agent works; without one, only yours
 * @param {{ home?: string, configDir?: string|null, read?: (path: string) => Promise<string>, list?: (path: string) => Promise<string[]> }} [opts]
 *   injected by tests, so they never read the real home folder. configDir is CLAUDE_CONFIG_DIR, taken from the
 *   environment only for the real home folder, as mcp-config.mjs does.
 */
export async function yourSkills(
  folder,
  {
    home = homedir(),
    configDir = home === homedir() ? process.env.CLAUDE_CONFIG_DIR || null : null,
    read = (p) => readFile(p, 'utf8'),
    list = (p) => readdir(p),
  } = {},
) {
  const user = await skillsIn(join(configDir || join(home, '.claude'), 'skills'), read, list);
  const project = folder ? await skillsIn(join(folder, '.claude', 'skills'), read, list) : [];
  return [...user.map((name) => ({ name, scope: 'user' })), ...project.map((name) => ({ name, scope: 'project' }))];
}

/**
 * What the persona sheet lists: Postbox’s skills, yours and the project’s from disk (a project one wins a name, as in
 * Claude Code), the plugin skills the last init reported, and any the persona turned off that are gone now.
 * @param {{ found: { name: string, scope: string }[], seen?: string[], off?: string[] }} lists
 * @returns {{ name: string, scope: string, off: boolean }[]}
 */
export function skillList({ found, seen = [], off = [] }) {
  const offSet = new Set(off);
  /** @type {Map<string, string>} name → scope */
  const scopes = new Map(POSTBOX_SKILLS.map((name) => [name, 'postbox']));
  for (const f of found) if (!isPluginSkill(f.name)) scopes.set(f.name, f.scope);
  for (const name of seen) if (typeof name === 'string' && isPluginSkill(name) && !scopes.has(name) && name.length <= MAX_NAME) scopes.set(name, 'plugin');
  for (const name of offSet) if (!scopes.has(name)) scopes.set(name, 'unknown');
  return [...scopes].slice(0, MAX_SKILLS).map(([name, scope]) => ({ name, scope, off: offSet.has(name) }));
}

/** The skills a persona turned off (skillsOff), with the default for personas from before it existed. */
export const skillsOffOf = (persona) =>
  Array.isArray(persona?.skillsOff) ? persona.skillsOff.filter((n) => typeof n === 'string' && n && n.length <= MAX_NAME) : [];

/** A deny rule for each skill the persona turned off: it can’t run, though the agent may still be told of it. */
export const skillDenies = (persona) => skillsOffOf(persona).map((name) => `Skill(${name})`);

/** The settings that hide the user and project skills the persona turned off: `skillOverrides`, or nothing. */
export function skillOverrides(persona) {
  const hidden = skillsOffOf(persona).filter((name) => !isPluginSkill(name));
  return hidden.length ? { skillOverrides: Object.fromEntries(hidden.map((name) => [name, 'off'])) } : {};
}
