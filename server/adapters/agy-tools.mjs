// Antigravity’s tools in Claude Code’s names. Moved from server/adapters/antigravity-cli.mjs, which is at its size
// ceiling (designs/architecture.md, “Module and function size”).
import { AGY_SERVER } from './agy-settings.mjs';
import { isQuietTool } from './claude-stream.mjs';
import { POSTBOX_SERVER } from './setup.mjs';

// agy keeps its own files under ~/.gemini/antigravity-cli, and the model reads them back: each MCP tool’s schema
// before the first call (recorded: mcp/postbox_postbox/show_block.json), which is loading a tool, as Claude Code’s
// ToolSearch is; and, in the Gemini room UAT, a long tool output agy had saved, and its own notes on the conversation
// (brain/<conversation>/.system_generated/steps/14/output.txt, …/logs/transcript.jsonl). None of it is the agent’s
// work, so the steps are quiet.
const AGY_FILE = /[\\/]\.gemini[\\/]antigravity-cli[\\/](?:mcp|brain)[\\/]/;

// agy’s tools as Claude Code’s, where Postbox has words for them, with the input under Claude Code’s names. The
// parameter names are agy’s (recorded: read_file’s Path, run_command’s CommandLine, call_mcp_tool’s ServerName,
// ToolName and Arguments); a tool not listed keeps its own name.
const AS_CLAUDE = /** @type {Record<string, [string, (p: any) => any]>} */ ({
  run_command: ['Bash', (p) => ({ command: p.CommandLine })],
  read_file: ['Read', (p) => ({ file_path: p.Path ?? p.AbsolutePath })],
  view_file: ['Read', (p) => ({ file_path: p.AbsolutePath ?? p.Path })],
  write_file: ['Write', (p) => ({ file_path: p.Path ?? p.TargetFile })],
  write_to_file: ['Write', (p) => ({ file_path: p.TargetFile ?? p.Path })],
  edit_file: ['Edit', (p) => ({ file_path: p.Path ?? p.TargetFile })],
  replace_file_content: ['Edit', (p) => ({ file_path: p.TargetFile ?? p.Path })],
  multi_replace_file_content: ['Edit', (p) => ({ file_path: p.TargetFile ?? p.Path })],
  grep_search: ['Grep', (p) => ({ pattern: p.Query ?? p.Pattern })],
  find_by_name: ['Glob', (p) => ({ pattern: p.Pattern })],
  read_url_content: ['WebFetch', (p) => ({ url: p.Url })],
  search_web: ['WebSearch', (p) => ({ query: p.query ?? p.Query })],
});

/**
 * The tool a step stands for, in Claude Code’s naming, so Postbox’s own tools get the same labels and stay quiet:
 * an MCP call is mcp__<server>__<tool>, and Postbox’s server, which agy names postbox_postbox, is postbox.
 * @returns {{ name: string, input: any, quiet: boolean }}
 */
export function toolOf(step) {
  const name = String(step?.tool_name ?? step?.tool_info?.name ?? 'tool');
  const p = step?.tool_info?.parameters ?? {};
  if (name === 'call_mcp_tool' && p.ServerName && p.ToolName) {
    const server = p.ServerName === AGY_SERVER ? POSTBOX_SERVER : String(p.ServerName);
    const mcp = `mcp__${server}__${p.ToolName}`;
    return { name: mcp, input: p.Arguments ?? {}, quiet: isQuietTool(mcp) };
  }
  if ((name === 'read_file' || name === 'view_file') && AGY_FILE.test(String(p.Path ?? p.AbsolutePath ?? '')))
    return { name: 'ToolSearch', input: {}, quiet: true };
  const as = AS_CLAUDE[name];
  const input = as ? as[1](p) : {};
  // A parameter agy names differently than expected leaves the input empty: the step keeps a generic label.
  if (as && Object.values(input).every((v) => typeof v === 'string' && v)) return { name: as[0], input, quiet: false };
  return { name, input: {}, quiet: false };
}
