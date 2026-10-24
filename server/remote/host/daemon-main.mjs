// The `host` program (daemon.mjs’s header, #120): `host attach`, the relay ssh runs, which starts the daemon first if
// none answers; `host serve`, the daemon; and `host token`, install’s step that prints the token.

import { spawn as nodeSpawn } from 'node:child_process';
import { closeSync, constants, promises as fsp, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import net from 'node:net';
import { DIR_MODE, encode, FILE_MODE, message, socketPathFits } from '../../../shared/remote-protocol.mjs';
import { EXIT, HOST_ENTRY, LOCK_STALE_MS, LOG_KEEP_BYTES, SERVE_START_MS } from './daemon-constants.mjs';
import { createDaemon } from './daemon-create.mjs';
import { ensureToken } from './daemon-files.mjs';
import { dropLock, ownerRecord, takeDaemonLock, takeLock } from './daemon-locks.mjs';
import { paths } from './paths.mjs';
import * as defaultProc from './proc.mjs';
import { NODE_MAJOR } from './programs.mjs';

/**
 * @typedef {{ argv: string[], getuid?: () => number, stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream,
 *   stderr?: { write: (s: string) => any }, home?: string, connect?: (path: string) => import('node:net').Socket,
 *   spawn?: any, now?: () => number, sleep?: (ms: number) => Promise<void>, nodeVersion?: string,
 *   umask?: (mask: number) => number, proc?: LockProc }} MainOpts
 * @typedef {import('./daemon-locks.mjs').LockProc} LockProc
 */

/**
 * `host attach` (the relay, starting the daemon if none answers), `host serve` (the daemon) and `host token` (makes the
 * token if it’s missing and prints it, for install). Resolves with the exit code; `serve` resolves only when the
 * daemon exits.
 * @param {MainOpts} o
 */
export async function main({
  argv,
  getuid = () => (process.getuid ? process.getuid() : -1),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  home,
  connect = (path) => net.connect(path),
  spawn = nodeSpawn,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  nodeVersion = process.version,
  umask = (mask) => process.umask(mask),
  proc = defaultProc,
}) {
  const say = (line) => stderr.write(`postbox host: ${line}\n`);
  const tell = (code, text) => {
    say(text);
    try {
      stdout.write(encode(message('daemon-to-postbox', 'error', { code, message: text })));
    } catch {}
  };
  const cmd = argv[0];
  if (cmd !== 'attach' && cmd !== 'serve' && cmd !== 'token') {
    say('Usage: host attach. Postbox runs it over ssh; it speaks JSON lines on stdin and stdout.');
    return EXIT.usage;
  }
  if (getuid() === 0) {
    tell('root', 'Postbox’s daemon doesn’t run as root. Connect to this host as your own user.');
    return EXIT.noperm;
  }
  if (Number(/^v?(\d+)/.exec(nodeVersion)?.[1] ?? 0) < NODE_MAJOR) {
    tell('no-node', `Postbox’s daemon needs Node ${NODE_MAJOR} or later, and this host’s node is ${nodeVersion}.`);
    return EXIT.unavailable;
  }
  const p = paths(home ? { home } : {});
  if (cmd === 'token') {
    // Install’s last step (server/remote/install.mjs): the token, made if it’s missing, on one line of its own.
    umask(0o077);
    try {
      stdout.write(`${ensureToken({ p, uid: getuid(), log: say })}\n`);
      return EXIT.ok;
    } catch (e) {
      tell('internal', `Couldn’t make or read the host’s token at ${p.token}: ${e.message}`);
      return EXIT.software;
    }
  }
  if (!socketPathFits(p.socket)) {
    tell('internal', `The daemon’s socket path, ${p.socket}, is too long for a Unix socket on Linux.`);
    return EXIT.software;
  }
  // An attach makes the version’s folder only while it holds the start lock (attach), never under an install.
  if (cmd === 'serve') {
    try {
      mkdirSync(p.code, { recursive: true, mode: DIR_MODE });
    } catch (e) {
      tell('internal', `Couldn’t make ${p.code}: ${e.message}`);
      return EXIT.software;
    }
    return serve({ p, home, say, connect, proc });
  }
  return attach({ p, stdin, stdout, say, tell, connect, spawn, now, sleep, proc });
}

/**
 * Connects to a Unix socket: the socket once it answers, or null when nothing listens (no file, or a stale one).
 * @param {(path: string) => import('node:net').Socket} connect @param {string} path
 * @returns {Promise<import('node:net').Socket | null>}
 */
export function tryConnect(connect, path) {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const onError = (e) => {
      sock.destroy();
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') resolve(null);
      else reject(e);
    };
    sock.once('error', onError);
    sock.once('connect', () => {
      sock.off('error', onError);
      resolve(sock);
    });
  });
}

/**
 * The relay: finds or starts the daemon (the header), then pipes stdin to its socket and the socket to stdout until
 * either side ends.
 */
async function attach({ p, stdin, stdout, say, tell, connect, spawn, now, sleep, proc }) {
  const lock = p.lock;
  const me = ownerRecord(proc);
  /** @type {import('node:net').Socket | null} */
  let sock = null;
  try {
    const deadline = now() + SERVE_START_MS + LOCK_STALE_MS;
    while (!sock && now() < deadline) {
      sock = await tryConnect(connect, p.socket);
      if (sock) break;
      if (!takeLock(lock, me, now, proc)) {
        await sleep(50);
        continue;
      }
      try {
        sock = await tryConnect(connect, p.socket);
        if (!sock) {
          mkdirSync(p.code, { recursive: true, mode: DIR_MODE });
          sock = await startServe({ p, connect, spawn, now, sleep, say });
        }
      } finally {
        dropLock(lock, me);
      }
    }
  } catch (e) {
    tell('internal', `Couldn’t reach or start the daemon: ${e.message}`);
    return EXIT.unavailable;
  }
  if (!sock) {
    tell('internal', `No daemon answered on ${p.socket}, and none could be started.`);
    return EXIT.unavailable;
  }
  const s = sock;
  return new Promise((resolve) => {
    stdin.pipe(s);
    s.pipe(stdout, { end: false });
    s.on('error', (e) => say(`The daemon’s socket failed: ${e.message}`));
    s.on('close', () => resolve(EXIT.ok));
  });
}

/** Starts `host serve` detached, its stderr on daemon.log, and waits for its socket to answer. */
async function startServe({ p, connect, spawn, now, sleep, say }) {
  const logPath = `${p.code}/daemon.log`;
  try {
    if (statSync(logPath).size > LOG_KEEP_BYTES) renameSync(logPath, `${logPath}.1`);
  } catch {}
  const fd = openSync(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, FILE_MODE);
  /** @type {string | null} */
  let exited = null;
  try {
    const child = spawn(process.execPath, [HOST_ENTRY, 'serve'], { detached: true, stdio: ['ignore', 'ignore', fd], env: process.env });
    child.on('error', (e) => {
      exited = `it couldn’t start: ${e.message}`;
    });
    child.on('exit', (code, sig) => {
      // 0: another daemon holds daemon.pid and is starting; its socket answers soon.
      if (code !== 0) exited = `it exited (${sig ?? code}); see ${logPath}`;
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  say(`Started the daemon; its log is ${logPath}.`);
  const deadline = now() + SERVE_START_MS;
  while (now() < deadline) {
    const sock = await tryConnect(connect, p.socket);
    if (sock) return sock;
    if (exited) throw new Error(`The daemon didn’t start: ${exited}.`);
    await sleep(50);
  }
  throw new Error(`The daemon didn’t answer on ${p.socket} within ${SERVE_START_MS / 1000} s; see ${logPath}.`);
}

/**
 * The daemon: takes daemon.pid, binds the socket and serves until it’s idle or told to stop.
 * @param {{ p: ReturnType<typeof paths>, home?: string, say: (line: string) => void, connect: (path: string) => import('node:net').Socket,
 *   proc: LockProc }} o
 */
async function serve({ p, home, say, connect, proc }) {
  process.umask(0o077);
  // An ssh session that ends can send SIGHUP; turns and the next attach don’t need this one to go.
  process.on('SIGHUP', () => {});
  const lock = takeDaemonLock(p.code, proc);
  if (lock.held === false) {
    say(lock.why);
    return lock.code;
  }
  const release = lock.release;
  let other;
  try {
    other = await tryConnect(connect, p.socket);
  } catch (e) {
    release();
    say(`Couldn’t tell whether a daemon serves ${p.socket} (${e.message}), so it’s left as it is; exiting.`);
    return EXIT.unavailable;
  }
  if (other) {
    other.destroy();
    release();
    say('Another daemon already serves this version; exiting.');
    return EXIT.ok;
  }
  await fsp.rm(p.socket, { force: true });
  const server = net.createServer();
  /** @type {(code: number) => void} */
  let exit = () => {};
  const done = new Promise((resolve) => {
    exit = resolve;
  });
  const daemon = createDaemon({
    home: home ?? process.env.POSTBOX_REMOTE_HOME ?? (await import('node:os')).homedir(),
    log: (line) => say(line),
    onIdle: () => shutdown(EXIT.ok),
    onRemoved: () => shutdown(EXIT.ok),
  });
  const shutdown = async (code) => {
    daemon.close();
    await fsp.rm(p.socket, { force: true }).catch(() => {});
    server.close();
    release();
    exit(code);
  };
  server.on('connection', (sock) => daemon.accept(sock));
  // Before the socket answers, so a SIGTERM from someone who has seen it answer always gets the clean shutdown.
  process.on('SIGTERM', () => shutdown(EXIT.ok));
  process.on('SIGINT', () => shutdown(EXIT.ok));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p.socket, () => resolve(undefined));
    });
    await fsp.chmod(p.socket, FILE_MODE);
    await daemon.start();
  } catch (e) {
    await shutdown(EXIT.software);
    throw e;
  }
  return done;
}
