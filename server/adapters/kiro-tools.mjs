// Kiro’s tools in Claude Code’s names. Moved from server/adapters/kiro-cli.mjs, which is at its size ceiling
// (designs/architecture/code-size.md, “Module and function size”).

import { clip } from '../harness-tools.mjs';

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
 * input (tool_id “postbox::show_block”) and _meta.kiro.serverName; v2 in _meta.kiro.toolName and mcpServerName. The
 * CLI of 23 November 2026 names the server alone, and the tool only in the call’s title, “@postbox/react”: read as
 * Kiro’s title, a reaction or a read showed as a step, and so as work its turn had to report (#1591).
 */
export function toolOf(u) {
  const kiro = u?._meta?.kiro ?? {};
  const id = typeof u?.rawInput?.tool_id === 'string' ? /^([^:]+)::(.+)$/.exec(u.rawInput.tool_id) : null;
  const server = id?.[1] ?? kiro.serverName ?? kiro.mcpServerName ?? null;
  // Only a title that names the call’s own server: another’s tool keeps Kiro’s words.
  const titled = typeof u?.title === 'string' && server ? /^@([^/]+)\/(.+)$/.exec(u.title) : null;
  const tool = id?.[2] ?? kiro.toolName ?? (titled && titled[1] === server ? titled[2] : null);
  if (server && tool) return { name: `mcp__${server}__${tool}`, input: id ? (u.rawInput.arguments ?? {}) : (u.rawInput ?? {}) };
  return asClaude(u?.kind, u?.rawInput ?? {});
}

/**
 * Kiro’s built-in tools as Claude Code’s, by their ACP kind and input (recorded: “Write File” is kind edit with
 * { path, text }, “Read File” kind read with { path }, a command kind execute with { command, description }), so the
 * Work ledger sees their files and commands. Anything else keeps Kiro’s title (name null).
 * @param {unknown} kind @param {any} i @returns {{ name: string|null, input: any }}
 */
function asClaude(kind, i) {
  const path = typeof i.path === 'string' && i.path ? i.path : null;
  if (kind === 'read' && path) return { name: 'Read', input: { file_path: path } };
  if (kind === 'edit' && path && typeof i.text === 'string') return { name: 'Write', input: { file_path: path, content: i.text } };
  if (kind === 'edit' && path) return { name: 'Edit', input: { file_path: path } };
  if (kind === 'execute' && typeof i.command === 'string' && i.command)
    return { name: 'Bash', input: { command: i.command, ...(i.description ? { description: i.description } : {}) } };
  if (kind === 'fetch' && typeof i.url === 'string' && i.url) return { name: 'WebFetch', input: { url: i.url } };
  return { name: null, input: i };
}

/**
 * A tool call’s update, as Postbox’s tool_call event. Moved from kiro-cli.mjs’s createKiroMapper.
 * @param {(e: any) => void} emit @param {Map<string, string>} kinds  toolCallId → its ACP kind @param {any} u
 */
export function toolCall(emit, kinds, u) {
  // Only a call’s first update names its kind.
  if (u.kind) kinds.set(u.toolCallId, u.kind);
  const { name, input } = toolOf({ ...u, kind: kinds.get(u.toolCallId) });
  // v3 loads tool definitions on demand (“Tool Load”), as Claude Code’s ToolSearch does.
  const native = u.title === 'Tool Load' ? 'ToolSearch' : clip(u.title || KINDS[/** @type {keyof typeof KINDS} */ (u.kind)] || 'Using a tool', 80);
  emit({ kind: 'tool_call', id: u.toolCallId, name: name ?? native, input, final: true, ...(native === 'ToolSearch' ? { work: false } : {}) });
}
