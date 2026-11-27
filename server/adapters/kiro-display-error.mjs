// What Kiro reports in a display_error (#489, #1171). When an MCP server fails to start, kiro-cli (3.1.0, and 3.6.2 as
// tests/fixtures/kiro-cli/auto-shell-files.jsonl records it) sends a session_info_update with _meta.kiro.kind
// “display_error” and errorType “mcp_connection_error”, and the turn still ends as a success, with the model offered none of that server’s tools. When the server is Postbox’s, the agent
// can’t show, send or read anything through Postbox that turn, as with any backend (tools-down.mjs).

import { INVISIBLE } from '../../shared/invisible.mjs';
import { cutText } from '../../shared/text-parts.mjs';
import { POSTBOX_SERVER } from './setup.mjs';
import { toolsDown } from './tools-down.mjs';

const MAX = 400;
let seen = 0; // display_errors reported, for their steps’ ids

/** A server that didn’t start, as Kiro words it at the start of the message: `MCP server "postbox" failed to connect: …`. */
const CONNECT = /^MCP server "([^"]{1,80})" failed to connect\b/;

/**
 * The words Kiro gave, cleaned before they reach a step, its label or the agent’s note (#1171): every character that
 * hides or reorders text (INVISIBLE) goes, control characters and line breaks become spaces, and the cut never splits
 * a character. @param {any} k
 */
const messageOf = (k) =>
  cutText(
    String(k?.message ?? k?.displayError?.message ?? '')
      .replace(INVISIBLE, '')
      .replace(/[\p{Cc}\s]+/gu, ' ')
      .trim(),
    MAX,
  );

/** The step’s label: another named server, or Kiro’s error. @param {string|null} server */
const labelOf = (server) => (server ? `MCP server ${server} didn’t load` : 'Kiro reported an error');

/**
 * A display_error becomes a failed step; when it says Postbox’s server didn’t start, the agent hears of it at its next
 * turn too. Only an mcp_connection_error that names its server at the start reads as a server that didn’t start
 * (#1171): another error, such as a tool’s (mcp_tool_error), or one that only mentions a server, is Kiro’s error.
 * @param {any} ctx @param {any} k  _meta.kiro
 */
export function reportDisplayError(ctx, k) {
  const message = messageOf(k);
  if (!message) return;
  const type = k?.errorType ?? k?.displayError?.errorType;
  const server = type === 'mcp_connection_error' ? (CONNECT.exec(message)?.[1] ?? null) : null;
  // Postbox’s own: the rule every backend shares (tools-down.mjs), with what Kiro said.
  if (server === POSTBOX_SERVER)
    return toolsDown(ctx, `Kiro couldn’t start Postbox’s tool server, so this turn had none of Postbox’s tools. Kiro said: “${message}”`);
  ctx.activity({ id: `kiro-error-${++seen}`, label: labelOf(server), state: 'failed', ms: 0, detail: message });
}
