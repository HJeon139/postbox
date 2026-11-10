// Postbox’s own MCP server failing to start for a turn (#1161, as #489 for Kiro). Claude Code’s init lists each MCP
// server with a status, and the Agent SDK’s is the same; a turn whose `postbox` server failed runs with none of
// Postbox’s tools, so nothing the agent meant to show, send or read through Postbox happens. The person sees a
// failed step that says so (postboxServerStatus, in claude-init.mjs), and the agent hears of it at its next turn,
// once, since it had no way to tell anyone: this note.

const NOTE =
  '[Postbox] In your last turn, Postbox’s tool server didn’t start, so you had none of Postbox’s tools, and nothing you meant to show, send or read through them happened. Postbox starts the server again for this turn: if you meant to use one of its tools, do it now.\n\n';

/**
 * The note for this turn when Postbox’s tools didn’t load last turn, cleared so it’s told once; else ''. A command is
 * the whole prompt, since Claude Code runs it only when the prompt is /name and its arguments (#67), and a re-attached
 * turn sends the agent nothing (#120): the note waits for the next turn that can carry it.
 * @param {any} ctx @param {any} message
 */
export function takeToolsDown(ctx, message) {
  if (message.slash || typeof message.attach === 'string') return '';
  if (!ctx.state?.postboxToolsDown) return '';
  ctx.saveState({ postboxToolsDown: null });
  // ctx.state is the turn's snapshot, so clear it there too: a retry within the turn, as the Agent SDK's after a lost
  // session, then doesn't take the note again.
  ctx.state.postboxToolsDown = null;
  return NOTE;
}
