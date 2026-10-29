// The store’s Redis 8 child process (designs/508/design.md, “Storage: a Redis 8 server that Postbox bundles and
// runs”, decisions 1, 3 and 7; requirements 4.3, “Store security”). Postbox starts it before it listens, with a
// password and its config, append-only file and log under the data folder. It has no TCP listener (`port 0`): Postbox
// reaches it on a Unix socket in a folder only the person can open (SR-1):
//
//   <data>/redis/redis.conf     written at each start (0600): socket, password, AOF fsynced per write, the two modules
//   <data>/redis/run/redis.sock the socket, in a 0700 folder; a data folder too long for a socket path uses a 0700
//                               folder in the system’s temporary folder instead, named by a hash of the data folder
//   <data>/redis/data/          the append-only files: the store itself
//   <data>/redis/logs/redis.log the child’s log, appended
//
// It restarts the child if it dies, and stops it when Postbox stops or exits. Its status names why it isn’t running
// (socket, owned, binary-missing, corrupt-aof, died), and writes fail closed meanwhile (server/store.mjs).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RedisClient, storeError } from './redis-client.mjs';
import { clearLeftover } from './redis-owner.mjs';
import { hashed, privateDir, privately, privateTree, STORE_COMMANDS, socketFor, writePrivate } from './redis-private.mjs';

/** @typedef {'socket' | 'owned' | 'binary-missing' | 'corrupt-aof' | 'died'} DownCause */
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
  owned: (_, detail) => `Postbox didn’t start the store’s Redis: it found one already running on this data folder. ${detail}`,
  'binary-missing': (s) => `The store’s Redis isn’t where Postbox keeps it (${s.home}). Start Postbox again to download it.`,
  'corrupt-aof': (s) =>
    `The store’s append-only file in ${join(s.dataDir, 'redis', 'data')} is damaged, so Redis won’t load it. Restore the data folder from its backup, or repair it with redis-check-aof, then Retry.`,
  died: () => 'The store’s Redis stopped. Postbox is starting it again; writes wait until it’s back.',
};

export class RedisSupervisor extends EventEmitter {
  /**
   * Tests only: children started while it’s set also have a `fixture` user with every command, for specs that set up
   * failures (CONFIG SET maxmemory) or read Redis’s stats. Postbox never sets it, so its Redis has no such user.
   */
  static fixtureUser = false;

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
    /** Postbox’s user’s password, new for each supervisor; only the store holds it (SR-2). */
    this.password = randomBytes(24).toString('hex');
    /** The owner’s: the supervisor’s own user, which may only shut the child down, for a later start’s cleanup. */
    this.ownerPassword = randomBytes(24).toString('hex');
    /** Test-only (RedisSupervisor.fixtureUser): a user with every command, for specs that set up failures. */
    this.fixturePassword = randomBytes(24).toString('hex');
    this.fixture = false;
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
    const message = MESSAGES[cause](this, detail) + (detail && cause === 'died' ? ` (${detail})` : '');
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
    const why = await clearLeftover({ dataDir: this.dataDir, socket: this.socket });
    if (why) throw this.down('owned', why);
    this.set({ state: 'starting' });
    const conf = await this.writeConf(files.modules);
    return this.run(files.server, conf);
  }

  /** @param {string[]} modules */
  async writeConf(modules) {
    const dir = join(this.dataDir, 'redis');
    await mkdir(join(dir, 'data'), { recursive: true, mode: 0o700 });
    await mkdir(join(dir, 'logs'), { recursive: true, mode: 0o700 });
    await privateTree(dir);
    const conf = join(dir, 'redis.conf');
    const lines = [
      'port 0',
      `unixsocket ${q(/** @type {string} */ (this.socket))}`,
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
      `user postbox on ${hashed(this.password)} resetchannels ~* -@all ${STORE_COMMANDS.map((c) => `+${c}`).join(' ')}`,
      `user owner on ${hashed(this.ownerPassword)} resetchannels resetkeys -@all +ping +shutdown`,
      ...((this.fixture = RedisSupervisor.fixtureUser) ? [`user fixture on ${hashed(this.fixturePassword)} ~* &* +@all`] : []),
      `dir ${q(join(dir, 'data'))}`,
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
    await writePrivate(conf, `${lines.join('\n')}\n`);
    // What a later start needs to shut this child down if Postbox doesn’t: the owner’s password, never Postbox’s user’s.
    await writePrivate(join(dir, 'owner.json'), `${JSON.stringify({ pid: process.pid, secret: this.ownerPassword })}\n`);
    return conf;
  }

  /** Spawns the child and waits for its ready line. @param {string} server @param {string} conf */
  run(server, conf) {
    const log = createWriteStream(join(this.dataDir, 'redis', 'logs', 'redis.log'), { flags: 'a', mode: 0o600 });
    const child = privately(() => spawn(server, [conf], { stdio: ['ignore', 'pipe', 'pipe'] }));
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

  /** A new connection to the child, as Postbox’s user. */
  client() {
    return new RedisClient({ path: /** @type {string} */ (this.socket), user: 'postbox', password: this.password }).connect();
  }

  /** Test-only: a connection with every command, when RedisSupervisor.fixtureUser was set before the start. */
  fixtureClient() {
    if (!this.fixture) return Promise.reject(new Error('Set RedisSupervisor.fixtureUser before the start.'));
    return new RedisClient({ path: /** @type {string} */ (this.socket), user: 'fixture', password: this.fixturePassword }).connect();
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
    // A private folder in the temporary folder, for a long data folder’s socket, goes once it’s empty.
    const folder = dirname(/** @type {string} */ (this.socket));
    if (folder !== join(this.dataDir, 'redis', 'run')) await rmdir(folder).catch(() => {});
    this.set({ state: 'stopped' });
  }
}
