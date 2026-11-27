// Whether a harness’s CLI is signed in, as its own status command says (#1608): the command each harness has, and how
// its exit code and output read. Only a state, a method’s short name and when the sign-in runs out are read: the
// outputs also hold the account’s email, organization and folders, which never leave this module. Anything not plainly
// signed in or out is unknown, so a CLI too old for its status command never reads as signed out.

/** A method is a short name such as claude.ai or BuilderId, as the protocol’s ID shape allows; anything else is left out. */
const METHOD_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

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
  return { state: 'signed-in', ...method(o.authMethod), expiresAt: expiry(o.loginExpiresAt) };
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
  if (r.exit === 0) return { state: 'signed-in', ...method(o.accountType) };
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

/** { method } for a short name, else nothing. @param {unknown} v */
const method = (v) => (typeof v === 'string' && METHOD_RE.test(v) ? { method: v } : {});

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
