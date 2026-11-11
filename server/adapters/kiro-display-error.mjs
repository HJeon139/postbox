// What Kiro reports in a display_error (#489). When an MCP server fails to start, kiro-cli 3.1.0 sends a
// session_info_update with _meta.kiro.kind “display_error” and errorType “mcp_connection_error”, and the turn still
// ends as a success, with the model offered none of that server’s tools. When the server is Postbox’s, the agent
// can’t show, send or read anything through Postbox that turn, as with any backend (tools-down.mjs).

import { POSTBOX_SERVER } from './setup.mjs';
import { toolsDown } from './tools-down.mjs';

const MAX = 400;
let seen = 0; // display_errors reported, for their steps’ ids

/** The words Kiro gave, bounded. @param {any} k */
const messageOf = (k) => String(k?.message ?? k?.displayError?.message ?? '').slice(0, MAX);

/** The step’s label: another named server, or Kiro’s error. @param {string|null} server */
const labelOf = (server) => (server ? `MCP server ${server} didn’t load` : 'Kiro reported an error');

/**
 * A display_error becomes a failed step; when it’s Postbox’s server, the agent hears of it at its next turn too.
 * @param {any} ctx @param {any} k  _meta.kiro
 */
export function reportDisplayError(ctx, k) {
  const message = messageOf(k);
  if (!message) return;
  const server = /MCP server "([^"]{1,80})"/.exec(message)?.[1] ?? null;
  // Postbox’s own: the rule every backend shares (tools-down.mjs), with what Kiro said.
  if (server === POSTBOX_SERVER)
    return toolsDown(ctx, `Kiro couldn’t start Postbox’s tool server, so this turn had none of Postbox’s tools. Kiro said: “${message}”`);
  ctx.activity({ id: `kiro-error-${++seen}`, label: labelOf(server), state: 'failed', ms: 0, detail: message });
}
