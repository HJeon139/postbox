// Kiro turn failures: readable exit text and a structured network cause for scheduled-wake recovery (#466, #467).

const NETWORK_CODE = /\b(EADDRNOTAVAIL|ENOTFOUND|ECONNRESET)\b/;

/** Keeps a portable network code from Kiro’s structured run error or process error. */
export function kiroError(message, cause = null) {
  const code = cause?.code ?? NETWORK_CODE.exec(String(cause?.message ?? cause ?? message))?.[1];
  const why = code ? Object.assign(cause instanceof Error ? cause : new Error(code), { code }) : cause instanceof Error ? cause : null;
  return why ? new Error(message, { cause: why }) : new Error(message);
}

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
