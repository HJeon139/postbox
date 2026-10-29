// Kiro turn failures kept outside kiro-cli.mjs at its size ceiling.

/** Why a turn failed, from its exit code, when the stream didn’t say (kiro.dev/docs/reference/exit-codes). */
export function kiroExitError(code, stderr = '') {
  if (code === 3)
    return 'An MCP server didn’t start, so Kiro didn’t run the turn. Check that Postbox is reachable, and your own servers if this persona loads them.';
  if (code === 4) return 'Kiro couldn’t find the agent Postbox wrote for this turn.';
  // Kiro logs a lot at INFO on stderr; the lines that aren’t say what went wrong.
  const why = String(stderr)
    .split('\n')
    .filter((line) => line.trim() && !/^\[INFO\]|ExperimentalWarning|--trace-warnings/.test(line))
    .slice(-3)
    .join(' ')
    .slice(0, 400);
  return `Kiro exited with code ${code}${why ? `: ${why}` : ''}.`;
}
