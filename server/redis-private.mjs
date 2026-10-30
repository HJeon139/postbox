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

/**
 * A password as redis.conf takes it: its SHA-256, so the file doesn’t hold it. SHA-256 is the only form Redis’s ACL
 * accepts, so no slower hash is possible here; and the value isn’t a person’s password but 32 random bytes made at each
 * start (CodeQL alert 116, dismissed as a false positive on 31 October 2026). @param {string} p
 */
export const hashed = (p) => `#${createHash('sha256').update(p).digest('hex')}`;

/** A value in redis.conf, quoted. @param {string} v */
const q = (v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The text of a data folder’s redis.conf: its socket, its users, its append-only files and the two modules.
 * @param {{ socket: string, dataDir: string, passwords: { postbox: string, owner: string, fixture: string | null }, modules: string[] }} o
 *   dataDir: the data folder’s redis folder; passwords.fixture: tests only (RedisSupervisor.fixtureUser), else null
 */
export function redisConf({ socket, dataDir, passwords, modules }) {
  const lines = [
    'port 0',
    `unixsocket ${q(socket)}`,
    'unixsocketperm 600',
    // Redis 8’s defaults, written rather than assumed (SR-4): no runtime change to protected settings, no DEBUG, and no
    // MODULE command, so the modules are the two loaded below at start and no others.
    'protected-mode yes',
    'enable-protected-configs no',
    'enable-debug-command no',
    'enable-module-command no',
    // No default user: a connection that hasn’t logged in gets NOAUTH (SR-3). Postbox’s user starts from nothing and
    // gets the store’s commands on its keys; the owner may only shut the child down.
    'user default off resetpass nocommands resetkeys resetchannels',
    `user postbox on ${hashed(passwords.postbox)} resetchannels ~* -@all ${STORE_COMMANDS.map((c) => `+${c}`).join(' ')}`,
    `user owner on ${hashed(passwords.owner)} resetchannels resetkeys -@all +ping +shutdown`,
    ...(passwords.fixture ? [`user fixture on ${hashed(passwords.fixture)} ~* &* +@all`] : []),
    `dir ${q(join(dataDir, 'data'))}`,
    // Each write is fsynced before Redis acknowledges it, during an AOF rewrite too (#525; designs/architecture.md,
    // “The store”): an emit or commit that resolved is on disk. An fsync that fails stops Redis rather than reply.
    'appendonly yes',
    'appendfsync always',
    'no-appendfsync-on-rewrite no',
    `appenddirname ${q('appendonly')}`,
    'save ""',
    'logfile ""',
    'daemonize no',
    ...modules.map((m) => `loadmodule ${q(m)}`),
  ];
  return `${lines.join('\n')}\n`;
}

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

/**
 * The environment the child gets: PATH, HOME and TMPDIR, where set, and nothing else of Postbox’s, which holds the
 * page token’s secrets, the agents’ keys and whatever the person’s shell exported (SR-7, the other way round).
 * @param {NodeJS.ProcessEnv} env
 */
export function childEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR']) if (env[k] !== undefined) out[k] = env[k];
  return out;
}
