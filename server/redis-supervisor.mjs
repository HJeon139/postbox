// The store’s Redis 8 child process (designs/508/design.md, “Storage: a Redis 8 server that Postbox bundles and
// runs”, decisions 1, 3 and 7). Postbox starts it before it listens, on a port it picks, bound to 127.0.0.1, with a
// password and its config, append-only file and log under the data folder:
//
//   <data>/redis/redis.conf     written at each start (0600): port, password, AOF everysec, the two modules
//   <data>/redis/data/          the append-only files: the store itself
//   <data>/redis/logs/redis.log the child’s log, appended
//
// It restarts the child if it dies, and stops it when Postbox stops or exits. Its status names why it isn’t running
// (port-taken, binary-missing, corrupt-aof, died), and writes fail closed meanwhile (server/store.mjs).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { RedisClient, storeError } from './redis-client.mjs';

/** @typedef {'port-taken' | 'binary-missing' | 'corrupt-aof' | 'died'} DownCause */
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

/** A free port on 127.0.0.1, from the system. */
const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer().once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
      s.close(() => ok(port));
    });
  });

/** A value in redis.conf, quoted. @param {string} v */
const q = (v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Why the child stopped, from what it logged. @param {string} log @returns {DownCause} */
function causeOf(log) {
  if (/Address already in use|Could not create server TCP listening socket/i.test(log)) return 'port-taken';
  if (/Bad file format reading the append only file|Unrecoverable error reading the append only file|AOF.*(corrupt|format)/i.test(log)) return 'corrupt-aof';
  return 'died';
}

const MESSAGES = {
  'port-taken': (s) =>
    `The store’s Redis couldn’t listen on port ${s.port}: another program has it. Close that program, or let Postbox pick a port, then Retry.`,
  'binary-missing': (s) => `The store’s Redis isn’t where Postbox keeps it (${s.home}). Start Postbox again to download it.`,
  'corrupt-aof': (s) =>
    `The store’s append-only file in ${join(s.dataDir, 'redis', 'data')} is damaged, so Redis won’t load it. Restore the data folder from its backup, or repair it with redis-check-aof, then Retry.`,
  died: () => 'The store’s Redis stopped. Postbox is starting it again; writes wait until it’s back.',
};

export class RedisSupervisor extends EventEmitter {
  /**
   * @param {{ home: string, dataDir: string, port?: number, restartMs?: number, readyMs?: number }} o
   *   port: a fixed port (otherwise one is picked at each start); restartMs: the first wait before a restart
   */
  constructor({ home, dataDir, port, restartMs = 250, readyMs = 15000 }) {
    super();
    this.home = home;
    this.dataDir = dataDir;
    this.fixedPort = port;
    this.port = port ?? 0;
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
    await this.shutDownLeftover();
    this.port = this.fixedPort ?? (await freePort());
    this.set({ state: 'starting' });
    const conf = await this.writeConf(files.modules);
    return this.run(files.server, conf);
  }

  /** A child an earlier Postbox left running on this data folder holds its files: ask it to shut down. */
  async shutDownLeftover() {
    const old = await readFile(join(this.dataDir, 'redis', 'redis.conf'), 'utf8').catch(() => '');
    const port = Number(old.match(/^port (\d+)$/m)?.[1]);
    const pass = old.match(/^requirepass "([0-9a-f]+)"$/m)?.[1];
    if (!port || !pass) return;
    const c = await new RedisClient({ port, password: pass }).connect().catch(() => null);
    if (!c) return;
    await c.call('SHUTDOWN').catch(() => {}); // the connection closes as it exits
    c.close();
    const listening = () =>
      new RedisClient({ port })
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
      'bind 127.0.0.1',
      `port ${this.port}`,
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

  async restart() {
    if (this.stopping) return;
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
    return new RedisClient({ port: this.port, password: this.password }).connect();
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
