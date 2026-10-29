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
//   <data>/redis/claims/        which supervisor may run it: one live claim at a time (server/redis-owner.mjs, SR-6)
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
import { claimRedis, clearLeftover } from './redis-owner.mjs';
import { privateDir, privately, privateTree, redisConf, socketFor, writePrivate } from './redis-private.mjs';

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
    /** Lets go of this supervisor’s claim on the data folder’s Redis (claimRedis), while it holds one. @type {(() => void) | null} */
    this.unclaim = null;
    /** The start under way, which a stop waits for before the claim goes. @type {Promise<unknown> | null} */
    this.starting = null;
    /** The stop under way, which a new start waits for. @type {Promise<void> | null} */
    this.stopped = null;
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
    while (this.stopped) await this.stopped;
    this.stopping = false;
    const p = this.begin();
    this.starting = p;
    try {
      return await p;
    } finally {
      if (this.starting === p) this.starting = null;
    }
  }

  /**
   * Before each step of a start that writes or spawns: a stop asked meanwhile ends the start there, before the step.
   * The start then lets go of its claim itself, and the stop waits for that (SR-6): until then the folder is still this
   * supervisor’s, so another start can’t take it while this one could still write its config or start a child.
   */
  halt() {
    if (!this.stopping) return;
    this.set({ state: 'stopped' });
    throw storeError('ESTOREDOWN', 'Postbox stopped the store’s Redis before it started.');
  }

  /** start(), once no stop is under way. */
  async begin() {
    let files;
    try {
      files = redisFiles(this.home);
      for (const m of files.modules) if (!existsSync(m)) throw new Error(`no module at ${m}`);
    } catch (e) {
      throw this.down('binary-missing', e.message);
    }
    if (!this.socket) throw this.down('socket', 'no socket path fits');
    // The data folder’s Redis is this supervisor’s alone from before the leftover check until it stops (SR-6): another
    // start that claims it meanwhile refuses before it touches the socket, the config or the append-only files. A
    // restart keeps the claim it has.
    if (!this.unclaim) {
      const { release, why } = await claimRedis(this.dataDir);
      if (!release) throw this.down('owned', why);
      // A Postbox that exits without stopping it leaves no claim behind; one that’s killed leaves a dead process’s.
      process.on('exit', release);
      this.unclaim = () => {
        process.off('exit', release);
        this.unclaim = null;
        release();
      };
    }
    try {
      this.halt();
      try {
        await privateDir(join(this.socket, '..'));
      } catch (e) {
        throw this.down('socket', e.message);
      }
      this.halt();
      const why = await clearLeftover({ dataDir: this.dataDir, socket: this.socket });
      if (why) throw this.down('owned', why);
      this.halt();
      this.set({ state: 'starting' });
      const conf = await this.writeConf(files.modules);
      return await this.run(files.server, conf);
    } catch (e) {
      // A start that failed holds nothing: another Postbox may take the folder, and Retry claims it again.
      this.unclaim?.();
      throw e;
    }
  }

  /** @param {string[]} modules */
  async writeConf(modules) {
    const dir = join(this.dataDir, 'redis');
    this.halt();
    await mkdir(join(dir, 'data'), { recursive: true, mode: 0o700 });
    this.halt();
    await mkdir(join(dir, 'logs'), { recursive: true, mode: 0o700 });
    this.halt();
    await privateTree(dir);
    const conf = join(dir, 'redis.conf');
    this.fixture = RedisSupervisor.fixtureUser;
    const passwords = { postbox: this.password, owner: this.ownerPassword, fixture: this.fixture ? this.fixturePassword : null };
    const text = redisConf({ socket: /** @type {string} */ (this.socket), dataDir: dir, passwords, modules });
    this.halt();
    await writePrivate(conf, text);
    // What a later start needs to shut this child down if Postbox doesn’t: the owner’s password, never Postbox’s user’s.
    this.halt();
    await writePrivate(join(dir, 'owner.json'), `${JSON.stringify({ pid: process.pid, secret: this.ownerPassword })}\n`);
    return conf;
  }

  /** Spawns the child and waits for its ready line. @param {string} server @param {string} conf */
  run(server, conf) {
    // Nothing between this check and the spawn waits, so a stop can’t come between them.
    this.halt();
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
  stop() {
    this.stopping = true;
    const p = this.end().finally(() => {
      if (this.stopped === p) this.stopped = null;
    });
    this.stopped = p;
    return p;
  }

  /** stop(), once `stopping` is set. */
  async end() {
    const child = this.child;
    const running = child && child.exitCode === null && child.signalCode === null;
    if (running) {
      const gone = new Promise((ok) => child.once('exit', ok));
      child.kill('SIGINT');
      const t = setTimeout(() => child.kill('SIGKILL'), 5000);
      await gone;
      clearTimeout(t);
    }
    // A start still under way keeps the claim until it can no longer write or spawn: it halts at its next step (a child
    // it started is the one just stopped) and lets go of the claim itself. Only then does a stop let go of one.
    await this.starting?.catch(() => {});
    this.unclaim?.();
    if (!running) {
      if (this.status.state !== 'down') this.set({ state: 'stopped' });
      return;
    }
    // A private folder in the temporary folder, for a long data folder’s socket, goes once it’s empty.
    const folder = dirname(/** @type {string} */ (this.socket));
    if (folder !== join(this.dataDir, 'redis', 'run')) await rmdir(folder).catch(() => {});
    this.set({ state: 'stopped' });
  }
}
