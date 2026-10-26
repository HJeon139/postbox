// The daemon’s files (daemon.mjs’s header, #120): reading a turn’s records, writing atomically, and the host’s token,
// which each connection proves and each runner checks.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, promises as fsp, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { DIR_MODE, FILE_MODE, TURN_FILES, validateExitRecord } from '../../../shared/remote-protocol.mjs';
import { ASK_TIMEOUT_MS } from './daemon-constants.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon */

export const exists = (/** @type {string} */ path) =>
  fsp.lstat(path).then(
    () => true,
    () => false,
  );
/** exit.json, when it’s there and valid. @param {Daemon} d @param {string} turn */
export const readExit = async (d, turn) => {
  try {
    const r = validateExitRecord(JSON.parse(await fsp.readFile(d.p.turn(turn, TURN_FILES.exit), 'utf8')));
    return r.ok ? r.msg : null;
  } catch {
    return null;
  }
};
export const readJson = async (/** @type {string} */ path) => {
  try {
    return JSON.parse(await fsp.readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
};
export const sizeOf = (/** @type {string} */ path) =>
  fsp.stat(path).then(
    (s) => s.size,
    () => 0,
  );
/** Writes a file atomically, mode 0600: a temporary file beside it, then rename. @param {Daemon} d @param {string} path @param {string} text */
export const writeAtomic = async (d, path, text) => {
  const tmp = `${path}.${process.pid}.${++d.ids}.tmp`;
  await fsp.writeFile(tmp, text, { mode: FILE_MODE, flag: 'wx' });
  await fsp.rename(tmp, path);
};
/** The host’s token, as this daemon’s home has it, or null if it can’t be read. @param {Daemon} d */
export const readToken = (d) => {
  try {
    return readFileSync(d.p.token, 'utf8').trim() || null;
  } catch {
    return null;
  }
};
/** Whether the turn’s runner answers `who` with its turn. Given the token, so the runner checks this home’s. @param {Daemon} d @param {string} turn */
export const runnerAlive = async (d, turn) => {
  const token = readToken(d);
  if (!token) return false;
  return d.askRunner(d.p.turn(turn, TURN_FILES.socket), turn, { timeoutMs: ASK_TIMEOUT_MS, token }).catch(() => false);
};

/** Whether a token matches the file’s, in constant time. A missing or unreadable file matches nothing. @param {Daemon} d @param {unknown} given */
export function tokenMatches(d, given) {
  let want;
  try {
    want = Buffer.from(readFileSync(d.p.token, 'utf8').trim());
  } catch (e) {
    d.log(`Couldn’t read the token at ${d.p.token}: ${e.message}`);
    return false;
  }
  const got = Buffer.from(String(given));
  // timingSafeEqual needs equal lengths; compare want with itself so a wrong length takes as long.
  const same = timingSafeEqual(got.length === want.length ? got : want, want);
  return got.length === want.length && same && want.length > 0;
}

/**
 * The host’s token, made if missing: 32 random bytes as hex, 0600, in a 0700 folder. An existing one that’s group-
 * or other-accessible is set back to 0600, and said in the log, since the daemon can fix that itself; one that isn’t
 * a regular file of this user’s is refused, since anyone who could replace it could choose the token. Used by the
 * daemon at its start and by `host token`, install’s step that prints it for the laptop to keep.
 * @param {{ p: ReturnType<typeof import('../../../shared/remote-protocol.mjs').hostPaths>, uid: number, log: (line: string) => void }} o
 *   uid: this user’s, which the token file must be owned by (-1 where there are no user IDs)
 * @returns {string} the token
 */
export function ensureToken({ p, uid, log }) {
  mkdirSync(p.root, { recursive: true, mode: DIR_MODE });
  const st = statSync(p.root);
  if ((st.mode & 0o777) !== DIR_MODE) {
    log(`${p.root} was mode ${(st.mode & 0o777).toString(8)}; setting it to 700.`);
    try {
      chmodSync(p.root, DIR_MODE);
    } catch (e) {
      log(`Couldn’t set ${p.root} to 700: ${e.message}`);
    }
  }
  try {
    const made = randomBytes(32).toString('hex');
    writeFileSync(p.token, made, { mode: FILE_MODE, flag: 'wx' });
    log(`Made the token at ${p.token}.`);
    return made;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const tok = lstatSync(p.token);
  if (!tok.isFile() || (uid >= 0 && tok.uid !== uid))
    throw new Error(
      `${p.token} isn’t a file of this user’s (${tok.isFile() ? `it’s owned by user ${tok.uid}` : 'it isn’t a regular file'}), so the daemon won’t trust it. Remove it and reinstall Postbox on the host to make a new one.`,
    );
  if (tok.mode & 0o077) {
    log(`${p.token} was mode ${(tok.mode & 0o777).toString(8)}; setting it to 600.`);
    chmodSync(p.token, FILE_MODE);
  }
  return readFileSync(p.token, 'utf8').trim();
}
