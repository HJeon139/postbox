// The card for a permission prompt on an Antigravity turn, built from the call the turn’s stream showed (#907).
// Postbox’s PreToolUse hook (agy-hook.mjs, decideAgyTool) asks with a card of its own making, which a command the agent
// runs could copy and change, so the card isn’t the prompt’s: it’s made here from the stream’s raw call ({ name, args }:
// agy’s tool name and its parameters, which turn-work.mjs keeps with the call), the hook’s card for it in every part the
// call decides, and its whole scope where the hook would ask about part of it. A prompt counts only when it agrees with
// that card, its tool and each value the call decides; any other is refused as #665’s are (server/prompt-claim.mjs).
// Which path the hook asks about, and whether it asks at all, read the files where agy runs and the turn’s mode, which
// the call doesn’t say: so a read’s card names every path the call does, and a prompt for a call the hook would have
// allowed still gets its card.

import { isDeepStrictEqual } from 'node:util';
import { PROTECTED_CMD, PROTECTED_WARNING, READ_TOOLS, WRITE_TOOLS } from './agy-hook.mjs';
import { pathArgs, tidyPath } from './agy-paths.mjs';

const MCP_TOOLS = new Set(['call_mcp_tool', 'list_resources', 'read_resource']);

/** @typedef {{ tool: string, input: Record<string, unknown> }} Card */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The paths a call names, as a card names them, each once; null when one isn’t a path. @param {Record<string, unknown>} p */
function namedPaths(p) {
  const named = pathArgs(p);
  if (named.some((x) => typeof x !== 'string')) return null;
  return [...new Set(named.map((x) => tidyPath(/** @type {string} */ (x))))];
}

/**
 * The card for the stream’s call, if the prompt agrees with it; else null, and the prompt is refused.
 * @param {{ name?: unknown, args?: unknown } | null | undefined} raw  the stream’s call, as agy named it
 * @param {{ tool_name?: unknown, input?: unknown }} prompt  permission_prompt’s arguments
 * @returns {Card | null}
 */
export function hookPromptCard(raw, prompt) {
  const input = prompt?.input;
  if (typeof raw?.name !== 'string' || !isRecord(input)) return null;
  const name = raw.name.trim().toLowerCase();
  const p = isRecord(raw.args) ? raw.args : {};
  const card = cardOf(name, p, input);
  return card && prompt.tool_name === card.tool ? card : null;
}

/**
 * The card for a call of tool `name` with parameters `p`, or null when the prompt’s input doesn’t agree with it.
 * @param {string} name @param {Record<string, any>} p @param {Record<string, any>} input
 * @returns {Card | null}
 */
function cardOf(name, p, input) {
  if (MCP_TOOLS.has(name)) {
    const args = isRecord(p.Arguments) ? p.Arguments : {};
    const tool = `mcp__${String(p.ServerName ?? '') || 'mcp'}__${String(p.ToolName ?? '') || name}`;
    return isDeepStrictEqual(input, args) ? { tool, input: args } : null;
  }
  if (WRITE_TOOLS.has(name)) return writeCard(name, p, input);
  if (READ_TOOLS.has(name)) return readCard(p, input);
  if (name === 'run_command') {
    const command = String(p.CommandLine ?? '');
    if (input.command !== command) return null;
    // agy’s summary of the command isn’t in its stream: the card keeps only the hook’s warning, which the call decides.
    return { tool: 'Bash', input: { command, ...(PROTECTED_CMD.test(command) ? { description: PROTECTED_WARNING } : {}) } };
  }
  if (name === 'search_web') return exact('WebSearch', { query: String(p.query ?? p.Query ?? '') }, input);
  if (name === 'read_url_content') return exact('WebFetch', { url: String(p.Url ?? p.url ?? '') }, input);
  // Any other tool’s card is its whole input, which only the stream’s parameters can show: a prompt with more than the
  // stream showed would be allowed for what no card showed, so it gets none, and the call is denied.
  return exact(name, p, input);
}

/** @param {string} tool @param {Record<string, unknown>} want @param {Record<string, unknown>} input @returns {Card | null} */
const exact = (tool, want, input) => (isDeepStrictEqual(input, want) ? { tool, input: want } : null);

/**
 * An edit’s card: the one file the call names. A call that names more can’t be one card’s file, so it gets none.
 * @param {string} name @param {Record<string, unknown>} p @param {Record<string, any>} input @returns {Card | null}
 */
function writeCard(name, p, input) {
  const paths = namedPaths(p);
  if (paths?.length !== 1 || input.file_path !== paths[0]) return null;
  return { tool: name.startsWith('write') ? 'Write' : 'Edit', input: { file_path: paths[0] } };
}

/**
 * A read’s card: every path the call names, the one the prompt asked about first, so allowing it allows only what each
 * is judged for (read-folders.mjs’s readPaths), where the hook names only those outside the agent’s folders. A call
 * that names none it can read is a card with an empty file_path, as the hook asks it.
 * @param {Record<string, unknown>} p @param {Record<string, any>} input @returns {Card | null}
 */
function readCard(p, input) {
  const paths = namedPaths(p);
  if (!paths?.length) return isDeepStrictEqual(input, { file_path: '' }) ? { tool: 'Read', input: { file_path: '' } } : null;
  const asked = input.file_path;
  if (typeof asked !== 'string' || !paths.includes(asked)) return null;
  const ordered = [asked, ...paths.filter((x) => x !== asked)];
  return { tool: 'Read', input: { file_path: asked, ...(ordered.length > 1 ? { paths: ordered } : {}) } };
}
