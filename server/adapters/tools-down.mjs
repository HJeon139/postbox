// Postbox’s own MCP server failing to start for a turn (#1161, as #489 for Kiro). Claude Code’s init lists each MCP
// server with a status, and the Agent SDK’s is the same; a turn whose `postbox` server failed runs with none of
// Postbox’s tools, so nothing the agent meant to show, send or read through Postbox happens. The person sees a
// failed step that says so (postboxServerStatus, in claude-init.mjs), and the agent hears of it at its next turn,
// once, since it had no way to tell anyone: this note.

const NOTE =
  '[Postbox] In your last turn, Postbox’s tool server didn’t start, so you had none of Postbox’s tools, and nothing you meant to show, send or read through them happened. Postbox starts the server again for this turn: if you meant to use one of its tools, do it now.\n\n';

/** The note for this turn when Postbox’s tools didn’t load last turn, cleared so it’s told once; else ''. @param {any} ctx */
export function takeToolsDown(ctx) {
  if (!ctx.state?.postboxToolsDown) return '';
  ctx.saveState({ postboxToolsDown: null });
  return NOTE;
}
