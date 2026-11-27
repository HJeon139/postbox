// Whether a harness’s CLI is signed in, as its own status command says (#1608): the command each harness has, and how
// its exit code and output read. Only a state, a method’s short name and when the sign-in runs out are read: the
// outputs also hold the account’s email, organization and folders, which never leave this module. Anything not plainly
// signed in or out is unknown, so a CLI too old for its status command never reads as signed out.
//
// Kiro keeps its sign-in outside KIRO_HOME (only an empty HOME signed it out when the fixtures were recorded), so an
// Isolated persona’s KIRO_HOME doesn’t change what `whoami`, run in the host’s own environment, answers.
//
// The commands aren’t only reads (measured 27 November 2026 on macOS, tests/fixtures/remote/signin/README.md): three
// runs each of `claude auth status` and `codex login status` changed none of their stored credentials, but kiro-cli’s
// `whoami` wrote its data.sqlite3, which holds its sign-in token, and the binary refreshes an expired token when it
// loads one, under a lock of its own. A refresh racing a Kiro turn’s is Kiro’s to settle: its lock, and its check that
// doesn’t save a stale token, hold it, and Postbox reads none of it.

/**
 * The method names each harness is known to give, so nothing else reaches the host’s status and the event log (#1608).
 * Claude Code’s authMethod, and Kiro’s accountType: BuilderId as recorded, and the others kiro-cli 3.6.2’s binary
 * names beside it. A name not listed is left out, as if the CLI hadn’t said.
 */
const METHODS = {
  'claude-code': new Set(['claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party']),
  'kiro-cli': new Set(['BuilderId', 'IamIdentityCenter', 'ExternalIdP', 'ApiKey']),
};

/** How much of a status command’s output is read; theirs are a few hundred bytes. */
export const STATUS_OUTPUT_CHARS = 64 * 1024;

/**
 * @typedef {import('../../../shared/remote-protocol.mjs').SignInState} SignInState
 * @typedef {{ name: string, state: SignInState, method?: string, expiresAt?: number | null }} SignIn
 * @typedef {Omit<SignIn, 'name'>} Reading  what a run says, before its harness’s name is added
 * @typedef {{ exit: number | null, stdout: string }} StatusRun  how the command ended (null: it didn’t exit on its own), and its output
 */

/**
 * Each harness’s status command, by the adapter’s name (HARNESSES): its arguments after the program, whether its
 * output is read at all, and how a run reads. Codex’s output isn’t: its exit code says it all.
 * @type {Record<string, { args: string[], reads: boolean, read: (r: StatusRun) => Reading }>}
 */
export const STATUS_COMMANDS = {
  'claude-code': { args: ['auth', 'status'], reads: true, read: readClaude },
  codex: { args: ['login', 'status'], reads: false, read: readCodex },
  'kiro-cli': { args: ['whoami', '--format', 'json'], reads: true, read: readKiro },
};

/**
 * Claude Code’s `claude auth status`: JSON with loggedIn, exit 0 when signed in and 1 when not. Both must agree, so
 * an older claude that doesn’t know `auth status`, and exits 1 saying so, is unknown. authMethod is the method, and
 * loginExpiresAt (an ISO time, or null) when it runs out.
 * @param {StatusRun} r @returns {Reading}
 */
export function readClaude(r) {
  const o = json(r.stdout);
  if (r.exit === 1 && o?.loggedIn === false) return { state: 'signed-out' };
  if (r.exit !== 0 || o?.loggedIn !== true) return { state: 'unknown' };
  return { state: 'signed-in', ...method('claude-code', o.authMethod), expiresAt: expiry(o.loginExpiresAt) };
}

/** Codex’s `codex login status`: exit 0 when signed in, 1 when not; what it prints isn’t read. @param {StatusRun} r @returns {Reading} */
export function readCodex(r) {
  if (r.exit === 0) return { state: 'signed-in' };
  return { state: r.exit === 1 ? 'signed-out' : 'unknown' };
}

/**
 * Kiro’s `kiro-cli whoami --format json`: exit 0 with the account as JSON (accountType is the method), or 1 with
 * { account: null } when no one is signed in. Output that isn’t a JSON object is unknown, whatever the exit.
 * @param {StatusRun} r @returns {Reading}
 */
export function readKiro(r) {
  const o = json(r.stdout);
  if (!o) return { state: 'unknown' };
  if (r.exit === 0) return { state: 'signed-in', ...method('kiro-cli', o.accountType) };
  return { state: r.exit === 1 ? 'signed-out' : 'unknown' };
}

/** The output as a JSON object, or null. @param {string} text */
function json(text) {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null; // Not JSON: an older CLI’s words, or a cut-off answer, which read as unknown.
  }
}

/** { method } for a name the harness is known to give, else nothing. @param {keyof typeof METHODS} harness @param {unknown} v */
const method = (harness, v) => (typeof v === 'string' && METHODS[harness].has(v) ? { method: v } : {});

/** When a sign-in runs out, in epoch ms: from an ISO time or a number, else null. @param {unknown} v */
function expiry(v) {
  const ms = asMs(v);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

/** A time as epoch ms: an ISO string parsed, a number as it is, anything else NaN. @param {unknown} v */
function asMs(v) {
  if (typeof v === 'string') return Date.parse(v);
  if (typeof v === 'number') return v;
  return Number.NaN;
}
