// What Claude Code’s init says: its commands, moved out of claude-stream.mjs, and whether Postbox’s own MCP server
// failed to start (#1161). The Agent SDK’s init is the same.

import { POSTBOX_SERVER } from './setup.mjs';
import { toolsDown } from './tools-down.mjs';

/**
 * An init’s skills and commands (#67): `slash_commands` lists both, by name, `skills` says which are skills, and
 * `terminal_slash_commands` are bound to a terminal (recorded: doctor, color, focus, reload-plugins), so they’re left
 * out of other surfaces. Recorded in tests/fixtures/claude-code/permission-subagent.jsonl.
 * @param {any} init @returns {{ name: string, skill?: true }[]}
 */
export function commandsOf(init) {
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const terminal = new Set(strings(init?.terminal_slash_commands));
  const skills = new Set(strings(init?.skills));
  return strings(init?.slash_commands)
    .filter((n) => !terminal.has(n))
    .map((name) => (skills.has(name) ? { name, skill: true } : { name }));
}

/**
 * A failed step, and a note saved for the next turn, when an init lists Postbox’s server as failed.
 * @param {any} ctx @param {unknown} servers  the init’s mcp_servers
 */
export function postboxServerStatus(ctx, servers) {
  const ours = Array.isArray(servers) ? servers.find((s) => s?.name === POSTBOX_SERVER) : null;
  if (ours?.status !== 'failed') return;
  toolsDown(ctx, 'Postbox’s tool server didn’t start for this turn (its status was “failed”), so the turn had none of Postbox’s tools.');
}
