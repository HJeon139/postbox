// What keeps the store’s Redis private (#508’s requirements, 4.3, “Store security”; design, “Store security”): where
// its socket goes (SR-1), who may run what on it (SR-3), and its files’ modes (SR-5). server/redis-supervisor.mjs writes these into its config.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The longest socket path every supported platform takes: macOS’s sun_path holds 104 bytes with its NUL. */
const SOCKET_MAX = 100;

/**
 * Where a data folder’s Redis listens: <data>/redis/run/redis.sock, or, when that’s too long for a socket path, a
 * folder in the system’s temporary folder named by a hash of the data folder. Null when neither fits.
 * @param {string} dataDir @param {string} [tmp]
 */
export function socketFor(dataDir, tmp = tmpdir()) {
  const inData = join(dataDir, 'redis', 'run', 'redis.sock');
  if (Buffer.byteLength(inData) <= SOCKET_MAX) return inData;
  const hash = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16);
  const inTmp = join(tmp, `postbox-redis-${hash}`, 'redis.sock');
  return Buffer.byteLength(inTmp) <= SOCKET_MAX ? inTmp : null;
}

/**
 * Makes a folder only the person can open, or refuses one that isn’t theirs or is a link.
 * @param {string} dir
 */
export async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} isn’t a plain folder`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
  if ((st.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
}

/**
 * What Postbox’s user may run (SR-3): exactly the commands the store sends, from server/store-redis.mjs,
 * store-commit.mjs and store-import.mjs, and the calls their Lua makes, which Redis checks against the same list.
 * Everything else is refused, replication, migration, CONFIG, MODULE, DEBUG, ACL, SHUTDOWN and the cluster among it.
 * FLUSHDB is the importer’s reset of an import cut short, which only Store.load() runs, at startup; the user already
 * has DEL and EVAL on every key, so keeping it out would isolate nothing. A command a new caller sends is added here
 * with that caller.
 */
export const STORE_COMMANDS = [
  'ping',
  'eval',
  'get',
  'set',
  'hget',
  'hset',
  'del',
  'rename',
  'zadd',
  'zrem',
  'zrange',
  'xadd',
  'xrange',
  'json.set',
  'json.get',
  'json.mget',
  'flushdb',
];

/** A password as redis.conf takes it: its SHA-256, so the file doesn’t hold it. @param {string} p */
export const hashed = (p) => `#${createHash('sha256').update(p).digest('hex')}`;

/**
 * Writes a file only the person can read (0600), whatever mode an earlier one had: a new file beside it, renamed over
 * it, so a link put in its place is replaced rather than followed (SR-2, SR-5).
 * @param {string} path @param {string} text
 */
export async function writePrivate(path, text) {
  const part = `${path}.${randomBytes(4).toString('hex')}.part`;
  try {
    await writeFile(part, text, { mode: 0o600, flag: 'wx' });
    await rename(part, path);
  } finally {
    await rm(part, { force: true });
  }
}

/**
 * Makes a folder and everything in it private (SR-5): folders 0700; a file its owner may run (the server, a module:
 * Redis loads none without its execute bit) 0700; any other file, the data, logs and config among them, 0600. Links are
 * left as they are, never followed. Run at each start, so an install an earlier version left readable is fixed too.
 * @param {string} dir
 */
export async function privateTree(dir) {
  const st = await lstat(dir).catch(() => null);
  if (!st || st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if ((st.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
    for (const name of await readdir(dir)) await privateTree(join(dir, name));
  } else if (st.isFile()) {
    const mode = st.mode & 0o100 ? 0o700 : 0o600;
    if ((st.mode & 0o777) !== mode) await chmod(dir, mode);
  }
}

/** Runs fn with a umask that leaves what it creates private: the child inherits it, so Redis’s AOF files are 0600. */
export function privately(fn) {
  const old = process.umask(0o077);
  try {
    return fn();
  } finally {
    process.umask(old);
  }
}
