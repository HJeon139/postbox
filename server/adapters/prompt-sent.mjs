// When an adapter records a turn’s prompt (ctx.prompt, server/turn-prompt.mjs; #1528): only once its backend has it.
// With UAT recording mode off a turn has no ctx.prompt, and these give the adapter nothing to call.

/**
 * stdin.end’s callback for a prompt the CLI reads on stdin, or undefined with nothing to record. It records once the
 * write succeeded, so a CLI that exited before reading it (EPIPE) isn’t recorded as one that got it. On a host the
 * prompt goes in `start`’s message file, and end calls back before the daemon has it, so it waits for the daemon’s
 * word that the turn started (`started`, server/remote/process-receive.mjs): a host that never had the turn records none.
 * @param {any} ctx @param {any} child @param {{ guide?: string | null, text: string }} p
 */
export function recordOnceWritten(ctx, child, p) {
  if (!ctx.prompt) return undefined;
  return (/** @type {unknown} */ err) => {
    if (err) return;
    if (child.remote && !child.started) child.once('started', () => ctx.prompt(p));
    else ctx.prompt(p);
  };
}

/**
 * For a prompt given as an argument: recorded once the CLI started on it (the child’s `spawn`), so one that couldn’t
 * start (ENOENT) records none. @param {any} ctx @param {any} child @param {{ guide?: string | null, text: string }} p
 */
export function recordOnceSpawned(ctx, child, p) {
  if (ctx.prompt) child.once('spawn', () => ctx.prompt(p));
}

/**
 * For a backend that says it started more than once on one send: the Agent SDK’s CLI emits another `init` each time it
 * starts its loop again in the same query (a background job ending, a monitor’s wake). The prompt is recorded at the
 * first only. @param {any} ctx @param {{ guide?: string | null, text: string }} p
 */
export function recordOnce(ctx, p) {
  let done = !ctx.prompt;
  return () => {
    if (done) return;
    done = true;
    ctx.prompt(p);
  };
}
