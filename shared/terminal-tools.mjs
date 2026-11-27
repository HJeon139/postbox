// The MCP tools after which Claude Code lets a turn end with no text (#1712). Claude Code re-prompts a turn whose
// final answer printed nothing (“Your previous response had no visible output…”), which made an agent with nothing to
// add post a line anyway, and that line woke the agent that wrote last. CLAUDE_CODE_TERMINAL_MCP_TOOLS is undocumented:
// read from Claude Code 2.1.318’s bundle, and checked there by a local run. It takes a comma-separated list of full
// tool names (`mcp__<server>__<tool>`); when the latest tool result came from one of them, the CLI skips that re-prompt
// and the turn ends with an empty result. A turn that goes on working after the tool runs as before. Postbox’s own
// check, server/empty-reply.mjs, still decides whether a turn owed a reply.
//
// In shared/ because a remote host’s daemon merges its own list too (server/remote/host/daemon-start.mjs), and host
// code can import only shared/ and server/remote/host/.

/** The variable’s name, as Claude Code reads it. */
export const TERMINAL_TOOLS_VAR = 'CLAUDE_CODE_TERMINAL_MCP_TOOLS';

/**
 * A comma-separated list with `name` in it: the list as it was when the name is already there, else its names with
 * `name` appended.
 * @param {string | undefined} list @param {string} name
 */
export function withTerminalTool(list, name) {
  const names = String(list ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.includes(name)) return String(list);
  return [...names, name].join(',');
}

/**
 * The environment with `name` in its terminal-tools list, kept with whatever names the environment already had.
 * @param {Record<string, string | undefined>} env @param {string} name
 */
export function terminalToolsEnv(env, name) {
  return { ...env, [TERMINAL_TOOLS_VAR]: withTerminalTool(env[TERMINAL_TOOLS_VAR], name) };
}

/**
 * A host turn’s start.env with the host’s own list kept: the runner lays start.env over the daemon’s environment, so
 * the names the laptop sends would replace a list the host’s user set. Unchanged when start.env doesn’t set the list.
 * @param {Record<string, string | undefined>} hostEnv  the daemon’s @param {Record<string, string>} startEnv
 */
export function withHostTerminalTools(hostEnv, startEnv) {
  const sent = startEnv[TERMINAL_TOOLS_VAR];
  if (typeof sent !== 'string') return startEnv;
  const names = sent
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return { ...startEnv, [TERMINAL_TOOLS_VAR]: names.reduce(withTerminalTool, hostEnv[TERMINAL_TOOLS_VAR] ?? '') };
}
