// What Kiro reports in a display_error (#489). When an MCP server fails to start, kiro-cli 3.1.0 sends a
// session_info_update with _meta.kiro.kind “display_error” and errorType “mcp_connection_error”, and the turn still
// ends as a success, with the model offered none of that server’s tools. When the server is Postbox’s, the agent
// can’t show, send or read anything through Postbox that turn: the person sees a failed step that says so, and the
// agent hears of it at its next turn, since it had no way to tell them itself.

import { POSTBOX_SERVER } from './setup.mjs';

const MAX = 400;
let seen = 0; // display_errors reported, for their steps’ ids

/** The words Kiro gave, bounded. @param {any} k */
const messageOf = (k) => String(k?.message ?? k?.displayError?.message ?? '').slice(0, MAX);

/** The step’s label: Postbox’s tools, another named server, or Kiro’s error. @param {string|null} server @param {boolean} ours */
function labelOf(server, ours) {
  if (ours) return 'Postbox’s tools didn’t load';
  if (server) return `MCP server ${server} didn’t load`;
  return 'Kiro reported an error';
}

/**
 * A display_error becomes a failed step; when it’s Postbox’s server, it’s also saved for the next turn.
 * @param {any} ctx @param {any} k  _meta.kiro
 */
export function reportDisplayError(ctx, k) {
  const message = messageOf(k);
  if (!message) return;
  const server = /MCP server "([^"]{1,80})"/.exec(message)?.[1] ?? null;
  const ours = server === POSTBOX_SERVER;
  ctx.activity({
    id: `kiro-error-${++seen}`,
    label: labelOf(server, ours),
    state: 'failed',
    ms: 0,
    detail: ours ? `Kiro couldn’t start Postbox’s tool server, so this turn had none of Postbox’s tools. Kiro said: “${message}”` : message,
  });
  if (ours) ctx.saveState({ kiroToolsDown: message });
}

/** What the next turn is told first, once. @param {string} message  what Kiro said */
const toolsDownNote = (message) =>
  `[Postbox] In your last turn, Kiro couldn’t start Postbox’s tool server (Kiro said: “${message.slice(0, MAX)}”), so you had none of Postbox’s tools, and nothing you meant to show, send or read through them happened. Postbox starts the server again for this turn: if you meant to use one of its tools, do it now.\n\n`;

/** The note for this turn when Postbox’s tools didn’t load last turn, cleared so it’s told once; else ''. @param {any} ctx */
export function takeToolsDown(ctx) {
  const down = ctx.state?.kiroToolsDown;
  if (!down) return '';
  ctx.saveState({ kiroToolsDown: null });
  return toolsDownNote(String(down));
}
