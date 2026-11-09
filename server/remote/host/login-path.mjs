// The login shell’s PATH (#672, #474). sshd starts the daemon with `ssh host command`, a non-interactive shell whose
// PATH often holds only the system’s folders: the folders a person’s profile and rc files add (mise, nvm, a toolbox
// folder) are missing, so node and the harnesses’ CLIs aren’t found, and a turn’s harness runs without them. A probe
// on one host found none of them that way, only some with `zsh -lc`, and all of them with `zsh -lic`.
//
// So the daemon asks the person’s login shell, as a login, interactive shell, for its PATH: once per daemon start,
// and once more when a turn’s harness isn’t found (daemon-login.mjs). The shell runs from an argument array with stdin
// closed, in its own process group, for at most PROBE_MS; past it the whole group is killed. Its rc files may print
// anything, so only the text between this probe’s own markers, each with a fresh random token, is read, and only
// absolute entries without control characters are kept, at most MAX_ENTRIES of them and MAX_BYTES together.

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';

/** How long the login shell has to print its PATH. */
export const PROBE_MS = 5000;
/** The most entries, and bytes together, kept from the login shell’s PATH. */
export const MAX_ENTRIES = 200;
export const MAX_BYTES = 16 * 1024;
/** The most of the shell’s output read: rc files can print a lot before the PATH. */
const OUTPUT_MAX = 256 * 1024;
/** How long the output may take to end once the shell has exited, when a child it left holds it open. */
const DRAIN_MS = 200;
// A control character in an entry: a new line, a tab, an escape (shared/remote-settings.mjs refuses them in host paths).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/** @typedef {{ ok: true, entries: string[], ms: number } | { ok: false, why: string }} LoginPath */

/** The markers around the PATH a probe with this token prints. @param {string} token */
export function pathMarkers(token) {
  return { start: `<postbox-path-start-${token}>`, end: `<postbox-path-end-${token}>` };
}

/**
 * The script the login shell runs: it prints the markers around $PATH. Each marker goes as two pieces joined only in
 * the output, so a shell that echoes its commands (verbose, xtrace) never prints one whole.
 * @param {string} token  a UUID, so it needs no quoting inside ' '
 */
function script(token) {
  const { start, end } = pathMarkers(token);
  const tail = `${token}>`;
  const cut = (marker) => marker.slice(0, -tail.length);
  return `printf '\\n%s%s%s%s%s\\n' '${cut(start)}' '${tail}' "$PATH" '${cut(end)}' '${tail}'`;
}

/** The user’s login shell: the passwd entry’s, else $SHELL, else none. Only an absolute path is run. */
export function loginShell({ info = () => userInfo().shell, env = process.env } = {}) {
  /** @type {string | null} */
  let shell = null;
  try {
    shell = info();
  } catch {} // userInfo throws for a user with no passwd entry: $SHELL is next
  const found = shell || env.SHELL || null;
  return found?.startsWith('/') ? found : null;
}

/**
 * The entries of the text between the markers: absolute, without control characters, once each, cut at MAX_ENTRIES
 * and MAX_BYTES. @param {string} text
 */
export function parseEntries(text) {
  /** @type {string[]} */
  const kept = [];
  let bytes = 0;
  for (const entry of new Set(text.split(':'))) {
    if (!entry.startsWith('/') || CONTROL.test(entry)) continue;
    const size = Buffer.byteLength(entry) + (kept.length ? 1 : 0);
    if (kept.length >= MAX_ENTRIES || bytes + size > MAX_BYTES) break;
    kept.push(entry);
    bytes += size;
  }
  return kept;
}

/**
 * The PATH a turn runs with: the login shell’s entries first, then the daemon’s own that aren’t among them. The
 * daemon’s are dropped past maxBytes, so it fits start.env’s limit. @param {string[]} loginEntries
 * @param {string | undefined} ownPath @param {number} [maxBytes]
 */
export function mergePath(loginEntries, ownPath, maxBytes = Number.POSITIVE_INFINITY) {
  const entries = [...loginEntries];
  let bytes = Buffer.byteLength(entries.join(':'));
  for (const entry of (ownPath ?? '').split(':')) {
    if (!entry || entries.includes(entry)) continue;
    bytes += Buffer.byteLength(entry) + 1;
    if (bytes > maxBytes) break;
    entries.push(entry);
  }
  return entries.join(':');
}

/**
 * Asks the login shell for its PATH.
 * @param {{ shell?: string | null, spawnImpl?: typeof nodeSpawn, timeoutMs?: number, now?: () => number,
 *   newToken?: () => string, kill?: (pid: number, signal: NodeJS.Signals) => void, env?: NodeJS.ProcessEnv }} [o]
 * @returns {Promise<LoginPath>}
 */
export function probeLoginPath({
  shell = loginShell(),
  spawnImpl = nodeSpawn,
  timeoutMs = PROBE_MS,
  now = Date.now,
  newToken = randomUUID,
  kill = (pid, signal) => process.kill(pid, signal),
  env = process.env,
} = {}) {
  if (!shell) return Promise.resolve({ ok: false, why: 'this user has no login shell, in the passwd entry or $SHELL.' });
  const token = newToken();
  const t0 = now();
  return new Promise((resolve) => {
    /** @type {any} */
    let child;
    try {
      child = spawnImpl(shell, ['-lic', script(token)], { stdio: ['ignore', 'pipe', 'ignore'], detached: true, env });
    } catch (e) {
      resolve({ ok: false, why: `${shell} couldn’t start: ${e.message}` });
      return;
    }
    let out = '';
    let settled = false;
    /** @param {LoginPath} r */
    const settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      child.stdout?.destroy?.();
      resolve(r);
    };
    const limit = setTimeout(() => {
      try {
        kill(-child.pid, 'SIGKILL');
      } catch {} // the group is gone already: there’s nothing left to kill
      settle({ ok: false, why: `${shell} didn’t print its PATH within ${Math.round(timeoutMs / 100) / 10} s.` });
    }, timeoutMs);
    limit.unref?.();
    child.stdout?.on('data', (chunk) => {
      if (out.length < OUTPUT_MAX) out += String(chunk);
    });
    child.on('error', (e) => settle({ ok: false, why: `${shell} couldn’t start: ${e.message}` }));
    /** @param {number | null} code @param {string | null} signal */
    const ended = (code, signal) => {
      if (code !== 0) return settle({ ok: false, why: `${shell} exited with ${signal ?? `code ${code}`}.` });
      settle(readPath(out, token, shell, now() - t0));
    };
    child.on('close', ended);
    child.on('exit', (code, signal) => setTimeout(() => ended(code, signal), DRAIN_MS).unref?.());
  });
}

/** The PATH between this probe’s markers. @param {string} out @param {string} token @param {string} shell @param {number} ms @returns {LoginPath} */
function readPath(out, token, shell, ms) {
  const { start, end } = pathMarkers(token);
  const from = out.indexOf(start);
  const to = from === -1 ? -1 : out.indexOf(end, from + start.length);
  if (to === -1) return { ok: false, why: `${shell} didn’t print its PATH between Postbox’s markers.` };
  return { ok: true, entries: parseEntries(out.slice(from + start.length, to)), ms };
}
