// The laptop’s copy of a host’s token (install.mjs): one file per host, `<data>/remote-tokens/<host id>`, 0600 in a
// 0700 folder, never in the store or the state the page reads.

import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The laptop’s folder of tokens, under Postbox’s data folder. */
export const TOKENS_DIR = 'remote-tokens';
/** The daemon’s token’s shape (shared/remote-protocol.mjs checks hello.token against the same). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
/** A host ID, as store.mjs’s newId makes them; it names a file, so nothing else passes. */
const HOST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The token’s file on the laptop. @param {string} dataDir @param {unknown} hostId */
export function tokenFile(dataDir, hostId) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('Postbox’s data folder is needed to keep a host’s token.');
  if (typeof hostId !== 'string' || !HOST_ID_RE.test(hostId)) throw new TypeError(`“${String(hostId).slice(0, 80)}” isn’t a host ID.`);
  return join(dataDir, TOKENS_DIR, hostId);
}

/** Writes the token, 0600, in a 0700 folder: a temporary file beside it, then rename. @param {string} file @param {string} token */
export async function storeToken(file, token) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * A host’s token as the laptop keeps it, or null when there’s none (not installed from this Postbox, or forgotten).
 * A file that isn’t a regular file, or doesn’t hold a token, is no token.
 * @param {{ dataDir: string, hostId: string }} o
 * @returns {Promise<string | null>}
 */
export async function readToken({ dataDir, hostId }) {
  const file = tokenFile(dataDir, hostId);
  try {
    if (!(await lstat(file)).isFile()) return null;
    const token = (await readFile(file, 'utf8')).trim();
    return TOKEN_RE.test(token) ? token : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Forgets a host’s token on the laptop, as when the host is removed. Resolves with whether there was one.
 * @param {{ dataDir: string, hostId: string }} o
 */
export async function forgetToken({ dataDir, hostId }) {
  const file = tokenFile(dataDir, hostId);
  try {
    await lstat(file);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  await rm(file, { force: true });
  return true;
}
