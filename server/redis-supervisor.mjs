// The store’s Redis 8 child process (designs/508/design.md, “Storage: a Redis 8 server that Postbox bundles and
// runs”, decisions 1, 3 and 7; requirements 4.3, “Store security”). Postbox starts it before it listens, with a
// password and its config, append-only file and log under the data folder. It has no TCP listener (`port 0`): Postbox
// reaches it on a Unix socket in a folder only the person can open (SR-1):
//
//   <data>/redis/redis.conf     written at each start (0600): socket, password, AOF everysec, the two modules
//   <data>/redis/run/redis.sock the socket, in a 0700 folder; a data folder too long for a socket path uses a 0700
//                               folder in the system’s temporary folder instead, named by a hash of the data folder
//   <data>/redis/data/          the append-only files: the store itself
//   <data>/redis/logs/redis.log the child’s log, appended
//
// It restarts the child if it dies, and stops it when Postbox stops or exits. Its status names why it isn’t running
// (socket, binary-missing, corrupt-aof, died), and writes fail closed meanwhile (server/store.mjs).

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RedisClient, storeError } from './redis-client.mjs';

/** @typedef {'socket' | 'binary-missing' | 'corrupt-aof' | 'died'} DownCause */
/** @typedef {{ state: 'idle' | 'starting' | 'running' | 'stopped' } | { state: 'down', cause: DownCause, message: string }} RedisStatus */

/**
 * The server and the two modules in a Redis home: a Postbox package (bin/, modules/) or a Redis source tree built with
 * its modules (src/, modules/redisjson/, modules/redisearch/). POSTBOX_REDIS_HOME names one for development and tests.
 * @param {string} home
 */
export function redisFiles(home) {
  for (const [server, json, search] of [
    ['bin/redis-server', 'modules/rejson.so', 'modules/redisearch.so'],
    ['src/redis-server', 'modules/redisjson/rejson.so', 'modules/redisearch/redisearch.so'],
  ])
    if (existsSync(join(home, server))) return { server: join(home, server), modules: [join(home, json), join(home, search)] };
  throw Object.assign(new Error(`There’s no Redis server in ${home} (bin/redis-server or src/redis-server).`), { code: 'ENOENT' });
}

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

/** A value in redis.conf, quoted. @param {string} v */
const q = (v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Why the child stopped, from what it logged. @param {string} log @returns {DownCause} */
function causeOf(log) {
  if (/Failed opening Unix socket|Could not create server TCP listening socket/i.test(log)) return 'socket';
  if (/Bad file format reading the append only file|Unrecoverable error reading the append only file|AOF.*(corrupt|format)/i.test(log)) return 'corrupt-aof';
  return 'died';
}

const MESSAGES = {
  socket: () =>
    'The store’s Redis couldn’t open its private socket. Check that the data folder’s redis/run folder (or the private folder Postbox made for it in the temporary folder) belongs to you and isn’t a link, then Retry.',
  'binary-missing': (s) => `The store’s Redis isn’t where Postbox keeps it (${s.home}). Start Postbox again to download it.`,
  'corrupt-aof': (s) =>
    `The store’s append-only file in ${join(s.dataDir, 'redis', 'data')} is damaged, so Redis won’t load it. Restore the data folder from its backup, or repair it with redis-check-aof, then Retry.`,
  died: () => 'The store’s Redis stopped. Postbox is starting it again; writes wait until it’s back.',
};

export class RedisSupervisor extends EventEmitter {
  /**
   * @param {{ home: string, dataDir: string, restartMs?: number, readyMs?: number }} o
   *   restartMs: the first wait before a restart
   */
  constructor({ home, dataDir, restartMs = 250, readyMs = 15000 }) {
    super();
    this.home = home;
    this.dataDir = dataDir;
    /** The Unix socket it listens on; never told to agents or hosts (SR-7). */
    this.socket = socketFor(dataDir);
    this.restartMs = restartMs;
    this.readyMs = readyMs;
    this.password = randomBytes(24).toString('hex');
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** @type {RedisStatus} */
    this.status = { state: 'idle' };
    this.stopping = false;
    this.restarts = 0;
    this.killOnExit = () => this.child?.kill('SIGTERM');
  }

  /** @param {RedisStatus} s */
  set(s) {
    this.status = s;
    this.emit('status', s);
  }

  /** @param {DownCause} cause @param {string} [detail] */
  down(cause, detail) {
    const message = MESSAGES[cause](this) + (detail && cause === 'died' ? ` (${detail})` : '');
    this.set({ state: 'down', cause, message });
    return storeError('ESTOREDOWN', message);
  }

  /** Starts the child and resolves once it accepts connections; rejects with ESTOREDOWN and the cause. */
  async start() {
    this.stopping = false;
    let files;
    try {
      files = redisFiles(this.home);
      for (const m of files.modules) if (!existsSync(m)) throw new Error(`no module at ${m}`);
    } catch (e) {
      throw this.down('binary-missing', e.message);
    }
    if (!this.socket) throw this.down('socket', 'no socket path fits');
    try {
      await privateDir(join(this.socket, '..'));
    } catch (e) {
      throw this.down('socket', e.message);
    }
    await this.shutDownLeftover();
    this.set({ state: 'starting' });
    const conf = await this.writeConf(files.modules);
    return this.run(files.server, conf);
  }

  /** A child an earlier Postbox left running on this data folder holds its files: ask it to shut down. */
  async shutDownLeftover() {
    const old = await readFile(join(this.dataDir, 'redis', 'redis.conf'), 'utf8').catch(() => '');
    const pass = old.match(/^requirepass "([0-9a-f]+)"$/m)?.[1];
    const path = this.socket;
    if (!path || !pass) return;
    const c = await new RedisClient({ path, password: pass }).connect().catch(() => null);
    if (!c) return;
    await c.call('SHUTDOWN').catch(() => {}); // the connection closes as it exits
    c.close();
    const listening = () =>
      new RedisClient({ path })
        .connect()
        .then((x) => {
          x.close();
          return true;
        })
        .catch(() => false);
    for (let i = 0; i < 100 && (await listening()); i++) await new Promise((ok) => setTimeout(ok, 50));
  }

  /** @param {string[]} modules */
  async writeConf(modules) {
    const dir = join(this.dataDir, 'redis');
    await mkdir(join(dir, 'data'), { recursive: true });
    await mkdir(join(dir, 'logs'), { recursive: true });
    const conf = join(dir, 'redis.conf');
    const lines = [
      'port 0',
      `unixsocket ${q(/** @type {string} */ (this.socket))}`,
      'unixsocketperm 600',
      'protected-mode yes',
      `requirepass ${q(this.password)}`,
      `dir ${q(join(dir, 'data'))}`,
      'appendonly yes',
      'appendfsync everysec',
      `appenddirname ${q('appendonly')}`,
      'save ""',
      'logfile ""',
      'daemonize no',
      ...modules.map((m) => `loadmodule ${q(m)}`),
    ];
    await writeFile(conf, `${lines.join('\n')}\n`, { mode: 0o600 });
    return conf;
  }

  /** Spawns the child and waits for its ready line. @param {string} server @param {string} conf */
  run(server, conf) {
    const log = createWriteStream(join(this.dataDir, 'redis', 'logs', 'redis.log'), { flags: 'a' });
    const child = spawn(server, [conf], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    process.on('exit', this.killOnExit);
    let seen = '';
    return new Promise((ok, fail) => {
      let ready = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), this.readyMs);
      timer.unref();
      const onData = (chunk) => {
        log.write(chunk);
        if (!ready) seen = (seen + chunk.toString()).slice(-16384);
        if (!ready && /Ready to accept connections/.test(seen)) {
          ready = true;
          clearTimeout(timer);
          this.restarts = 0;
          // Once it runs, the child never keeps Postbox running: it’s killed when Postbox’s process exits.
          child.unref();
          for (const pipe of [child.stdout, child.stderr]) /** @type {any} */ (pipe)?.unref?.();
          this.set({ state: 'running' });
          ok(this);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (e) => {
        clearTimeout(timer);
        fail(this.down('binary-missing', e.message));
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        log.end();
        process.off('exit', this.killOnExit);
        if (this.child === child) this.child = null;
        if (ready) return this.exited(code, signal);
        fail(this.down(causeOf(seen), `exit ${code ?? signal}`));
      });
    });
  }

  /** The running child stopped: report it and, unless Postbox stopped it, start it again. */
  exited(code, signal) {
    if (this.stopping) return this.set({ state: 'stopped' });
    this.down('died', `exit ${code ?? signal}`);
    const wait = Math.min(this.restartMs * 2 ** this.restarts++, 5000);
    setTimeout(() => this.restart(), wait).unref();
  }

  /** Starts the child again, after it died or from the page’s Retry; one already starting or running is left alone. */
  async restart() {
    if (this.stopping || this.status.state === 'starting' || this.status.state === 'running') return;
    try {
      await this.start();
    } catch (e) {
      // A cause the person must fix stays as it is; a child that died again is tried again later.
      if (e.code === 'ESTOREDOWN' && this.status.state === 'down' && this.status.cause === 'died' && !this.stopping)
        setTimeout(() => this.restart(), Math.min(this.restartMs * 2 ** this.restarts++, 5000)).unref();
    }
  }

  /** A new connection to the child, authenticated. */
  client() {
    return new RedisClient({ path: /** @type {string} */ (this.socket), password: this.password }).connect();
  }

  /** Stops the child: SIGINT, which Redis takes as a clean shutdown that writes its AOF, then SIGKILL. */
  async stop() {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      if (this.status.state !== 'down') this.set({ state: 'stopped' });
      return;
    }
    const gone = new Promise((ok) => child.once('exit', ok));
    child.kill('SIGINT');
    const t = setTimeout(() => child.kill('SIGKILL'), 5000);
    await gone;
    clearTimeout(t);
    this.set({ state: 'stopped' });
  }
}
