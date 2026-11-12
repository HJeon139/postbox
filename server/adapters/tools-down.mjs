// Postbox’s own MCP server failing to start for a turn (#1161, #1162; #489 for Kiro). The backend reports it its own
// way: Claude Code’s and the Agent SDK’s init list the server as failed, and the turn runs with none of Postbox’s
// tools (claude-init.mjs); Codex, for which the server is required, refuses to open the turn (codex-thread.mjs); Kiro
// sends a display_error (kiro-display-error.mjs). Either way the person sees a failed step that says so, and the agent
// hears of it at its next turn, once, since it had no way to tell anyone (the runtime adds toolsDownNote). The rule
// lives here, for every backend.

const STEP = { id: 'postbox-tools-down', label: 'Postbox’s tools didn’t load', state: 'failed', ms: 0 };

/**
 * A failed step, and a note saved for the next turn.
 * @param {any} ctx @param {string} detail  what happened, for the person
 * @param {{ ran?: boolean }} [o]  ran: the turn went on without the tools (else it didn’t run)
 */
export function toolsDown(ctx, detail, { ran = true } = {}) {
  ctx.activity?.({ ...STEP, detail });
  ctx.saveState?.({ postboxToolsDown: ran ? 'ran' : 'refused' });
}

const NOTE = {
  ran: '[Postbox] In your last turn, Postbox’s tool server didn’t start, so you had none of Postbox’s tools, and nothing you meant to show, send or read through them happened. Postbox starts the server again for this turn: if you meant to use one of its tools, do it now.\n\n',
  refused:
    '[Postbox] In your last turn, Postbox’s tool server didn’t start, so the turn didn’t run and you never got its message: read_conversation has it. Postbox starts the server again for this turn.\n\n',
};

/**
 * The note for this turn when Postbox’s tools didn’t load last turn, or ''. The runtime adds it to the turn’s notices,
 * which every backend gives the agent, and clears it, so it’s told once, whatever the backend (#1161, #1162, #489). A
 * command is the whole prompt, since Claude Code runs it only when the prompt is /name and its arguments (#67), and a
 * re-attached turn sends the agent nothing (#120): the note waits for the next turn that can carry it.
 * @param {any} se  the session @param {any} message
 */
export function toolsDownNote(se, message) {
  if (message.slash || typeof message.attach === 'string') return '';
  const down = se?.backendState?.postboxToolsDown;
  if (!down) return '';
  return (down === 'refused' ? NOTE.refused : NOTE.ran).trim();
}
