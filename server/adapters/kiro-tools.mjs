// Kiro’s tools in Claude Code’s names. Moved from server/adapters/kiro-cli.mjs, which is at its size ceiling
// (designs/architecture.md, “Module and function size”).

// Labels for Kiro’s tool kinds (ACP’s ToolKind), until a title arrives.
export const KINDS = {
  read: 'Reading a file',
  edit: 'Editing a file',
  delete: 'Deleting a file',
  move: 'Moving a file',
  search: 'Searching files',
  execute: 'Running a command',
  fetch: 'Fetching a page',
  think: 'Thinking',
};

/**
 * The tool a call stands for, in Claude Code’s naming where Postbox has words for it: an MCP tool is
 * mcp__<server>__<tool>, so Postbox’s own tools get the same labels and stay quiet. v3 names an MCP call in its
 * input (tool_id “postbox::show_block”) and _meta.kiro.serverName; v2 in _meta.kiro.toolName and mcpServerName.
 */
export function toolOf(u) {
  const kiro = u?._meta?.kiro ?? {};
  const id = typeof u?.rawInput?.tool_id === 'string' ? /^([^:]+)::(.+)$/.exec(u.rawInput.tool_id) : null;
  const server = id?.[1] ?? kiro.serverName ?? kiro.mcpServerName ?? null;
  const tool = id?.[2] ?? kiro.toolName ?? null;
  if (server && tool) return { name: `mcp__${server}__${tool}`, input: id ? (u.rawInput.arguments ?? {}) : (u.rawInput ?? {}) };
  return { name: null, input: u?.rawInput ?? {} };
}
