// The person’s own MCP servers, read as Claude Code reads them (#59), for the persona sheet’s list. Only names
// and scopes leave this module: a server’s config (its command, environment or headers) can hold secrets.
//
// The scopes, in Claude Code’s order, later ones winning a name:
// - user: ~/.claude.json `mcpServers`;
// - project: <folder>/.mcp.json `mcpServers`, only those approved by `enableAllProjectMcpServers` or
//   `enabledMcpjsonServers` and not in `disabledMcpjsonServers`. The approvals live in the settings files (user,
//   project, local) and in ~/.claude.json `projects[<folder>]`;
// - local: ~/.claude.json `projects[<folder>].mcpServers`.
// A missing or malformed file counts as empty, so a broken config never breaks the sheet.
//
// The config files can’t say whether a server connects, and they don’t hold claude.ai connectors or plugin
// servers. The last `init` of a session does (its `mcp_servers`), so the list is the union of both, with the status
// from that init (mcpServerList below).

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { POSTBOX_SERVER } from './setup.mjs';

const MAX_SERVERS = 100;
const MAX_NAME = 200;
/** Statuses an init’s mcp_servers reports (sdk.d.ts, McpServerStatus), and “not started yet” before any turn. */
export const MCP_STATUSES = ['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'not-started'];

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const names = (servers) => (isObject(servers) ? Object.keys(servers).filter((n) => n && n.length <= MAX_NAME) : []);
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);

/**
 * The MCP servers configured for a folder: [{ name, scope }], scope being user, project or local.
 * @param {string|null} folder  where the agent works; without one, only the user scope applies
 * @param {{ home?: string, configDir?: string|null, read?: (path: string) => Promise<string> }} [opts]  injected by tests, so
 *   they never read the real home folder. configDir is CLAUDE_CONFIG_DIR, which moves both files Claude Code reads
 *   here: its global config to <configDir>/.claude.json, and the user settings to <configDir>/settings.json (as the
 *   CLI’s own code resolves them). It’s taken from the environment only for the real home folder.
 */
export async function yourMcpServers(
  folder,
  { home = homedir(), configDir = home === homedir() ? process.env.CLAUDE_CONFIG_DIR || null : null, read = (p) => readFile(p, 'utf8') } = {},
) {
  const json = async (path) => {
    try {
      const v = JSON.parse(await read(path));
      return isObject(v) ? v : {};
    } catch {
      return {};
    }
  };
  const claudeJson = await json(join(configDir || home, '.claude.json'));
  /** @type {Map<string, string>} */
  const found = new Map();
  for (const n of names(claudeJson.mcpServers)) found.set(n, 'user');
  if (folder) {
    const here = isObject(claudeJson.projects) && isObject(claudeJson.projects[folder]) ? claudeJson.projects[folder] : {};
    const approvals = [here, await json(join(configDir || join(home, '.claude'), 'settings.json')), await json(join(folder, '.claude', 'settings.json'))];
    approvals.push(await json(join(folder, '.claude', 'settings.local.json')));
    const all = approvals.some((s) => s.enableAllProjectMcpServers === true);
    const enabled = new Set(approvals.flatMap((s) => strings(s.enabledMcpjsonServers)));
    const disabled = new Set(approvals.flatMap((s) => strings(s.disabledMcpjsonServers)));
    for (const n of names((await json(join(folder, '.mcp.json'))).mcpServers)) if ((all || enabled.has(n)) && !disabled.has(n)) found.set(n, 'project');
    for (const n of names(here.mcpServers)) found.set(n, 'local');
  }
  found.delete(POSTBOX_SERVER);
  return [...found].slice(0, MAX_SERVERS).map(([name, scope]) => ({ name, scope }));
}

/**
 * What the persona sheet lists: the servers found in config, the ones the last init reported (claude.ai
 * connectors and plugin servers are only there), and the ones the persona turned off (they don’t appear in an
 * init once off). Each has a status from that init, or “not-started” before one; Postbox’s own isn’t listed.
 * @param {{ found: { name: string, scope: string }[], seen?: { name: string, status: string, source?: string }[], off?: string[] }} lists
 * @returns {{ name: string, scope: string, status: string, off: boolean }[]}
 */
export function mcpServerList({ found, seen = [], off = [] }) {
  const offSet = new Set(off);
  /** @type {Map<string, { name: string, scope: string, status: string, off: boolean }>} */
  const list = new Map();
  for (const f of found) list.set(f.name, { name: f.name, scope: f.scope, status: 'not-started', off: offSet.has(f.name) });
  for (const s of seen) {
    const status = MCP_STATUSES.includes(s.status) ? s.status : 'failed';
    const was = list.get(s.name);
    list.set(s.name, { name: s.name, scope: was?.scope ?? scopeOf(s.source), status, off: offSet.has(s.name) });
  }
  for (const name of offSet) if (!list.has(name)) list.set(name, { name, scope: 'unknown', status: 'not-started', off: true });
  list.delete(POSTBOX_SERVER);
  return [...list.values()].slice(0, MAX_SERVERS);
}

// An init’s `source` (sdk.d.ts): a config scope, plugin, claudeai, or dynamic (--mcp-config).
const scopeOf = (source) => (source === 'claudeai' ? 'claude.ai' : typeof source === 'string' && source ? source.slice(0, 20) : 'unknown');
