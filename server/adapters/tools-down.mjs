// Postbox’s own MCP server failing to start for a turn (#1161, #1162; #489 for Kiro). The backend reports it its own
// way: Claude Code’s and the Agent SDK’s init list the server as failed, and the turn runs with none of Postbox’s
// tools (claude-init.mjs); Codex, for which the server is required, refuses to open the turn (codex-thread.mjs). Either
// way the person sees a failed step that says so, and the agent hears of it at its next turn, once, since it had no
// way to tell anyone. The rule lives here.

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

/** The note for this turn when Postbox’s tools didn’t load last turn, cleared so it’s told once; else ''. @param {any} ctx */
export function takeToolsDown(ctx) {
  const down = ctx.state?.postboxToolsDown;
  if (!down) return '';
  ctx.saveState({ postboxToolsDown: null });
  return down === 'refused' ? NOTE.refused : NOTE.ran;
}
