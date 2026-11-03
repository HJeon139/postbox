// Kiro turn failures: readable exit text and a structured network cause for scheduled-wake recovery (#466, #467).

const NETWORK_CODE = /\b(EADDRNOTAVAIL|ENOTFOUND|ECONNRESET)\b/;

/**
 * Keeps a portable network code from Kiro’s structured run error or process error.
 * @param {string} message @param {any} [cause]  an Error, or the text it failed with
 */
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

// A session grown past the request size limit fails every turn that resumes it, Retry included (#544). The text is
// as a real turn reported it, quoted in the issue: “Request exceeds the maximum allowed size (code -32000): …”.
export const overSizeLimit = (message) => /Request exceeds the maximum allowed size/.test(String(message ?? ''));

/** What such a session’s fresh start tells the agent, as FRESH_START_TEXT does for a missing session. */
export const SIZE_LIMIT_START_TEXT =
  'Your earlier conversation in this thread grew past Kiro’s request size limit, so this is a fresh start. Read large files and images a few at a time.';

/** Told to every Kiro agent, so its session doesn’t get there. */
export const SIZE_LIMIT_NOTE =
  '## Large files and images\n\nWhat you read in a turn goes into each later request, and Kiro refuses one over its request size limit. Read large files and images a few at a time, or make smaller copies first.';
