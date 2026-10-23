// A turn’s runner on a remote host (#120; architecture.md, “Remote hosts”, “A turn doesn’t depend on anything staying
// connected”). The daemon writes the turn folder and start.json, then runs `<node> runner.mjs <turn>` detached, so the
// runner leads its own session and process group, with no terminal and no stdio. The runner starts the harness from
// start.json’s program and argument list, never a shell, with its stdout appended to out.jsonl and its stderr to
// err.log. It records itself in runner.json first, and writes exit.json when the harness exits. It needs nothing else
// to stay up: the daemon can restart and the SSH connection can drop while it runs.
//
// It listens on the turn folder’s `sock`, which answers the daemon’s `who` with its turn ID and, for a held stdin
// (Codex), takes each line for the harness, appending it to in.jsonl before writing it to the pipe. Each connection
// proves the token first, as every connection on the host does.
//
// Stop signals the runner’s process group, so the harness gets SIGINT straight from the daemon. The runner ignores
// SIGINT, SIGTERM and SIGHUP, so it outlives the harness and can record how it ended. On SIGINT or SIGTERM it also
// closes a held stdin, the first step in stopping a stdio JSON-RPC server (C7). Otherwise the held pipe stays open
// until the harness exits; the protocol has no message to close it sooner.
//
// This file is also how the daemon starts runners and talks to them: launchRunner, askRunner and sendStdin.

import childProcess from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  createMessageReader,
  DIR_MODE,
  encode,
  FILE_MODE,
  MESSAGE_FILE,
  message,
  REMOTE_LIMITS,
  socketPathFits,
  TURN_FILES,
  validateExitRecord,
  validateRunnerRecord,
  validateStartRecord,
} from '../../../shared/remote-protocol.mjs';
import { hostVersion, PROGRAMS, paths } from './paths.mjs';
import { bootId, startTime } from './proc.mjs';

/** start.json is argv and env, each bounded well below this. */
const START_MAX_BYTES = 4 * REMOTE_LIMITS.argvBytes;
/** Exit codes for a harness that never started, as a shell reports them: not found, and found but not runnable. */
const NOT_FOUND = 127;
const NOT_RUNNABLE = 126;

// ── The runner ──────────────────────────────────────────────────────────────────────

/** A turn the runner won’t start; its message is the line for err.log. */
class Refusal extends Error {}

/** @param {string} why @returns {never} */
function refuse(why) {
  throw new Refusal(why);
}

/** Writes a file whole in one step: a reader sees the old file or the new one, never part of one. @param {string} path @param {string} text */
function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: FILE_MODE });
  renameSync(tmp, path);
}

/** Opens a file to append to, 0600 even if something else created it. @param {string} path */
function openAppend(path) {
  const fd = openSync(path, 'a', FILE_MODE);
  fchmodSync(fd, FILE_MODE);
  return fd;
}

/** Whether a `who` carries the host’s token. Read each time, so it’s never older than the file. @param {string} path @param {string} given */
function tokenMatches(path, given) {
  let want;
  try {
    want = Buffer.from(readFileSync(path, 'utf8').trim());
  } catch {
    return false;
  }
  const got = Buffer.from(given);
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Runs one turn, from start.json to exit.json, and resolves with the exit record once the socket is closed. A turn it
 * won’t start rejects with the reason, which is also the last line of err.log.
 * @param {string} turn
 */
export async function runTurn(turn) {
  process.umask(0o077);
  const p = paths();
  const dir = p.turn(turn); // throws on a turn ID that isn’t one, before any file is touched
  const info = lstatSync(dir);
  if (!info.isDirectory()) throw new Refusal(`${dir} isn’t a folder.`);
  const errFd = openAppend(`${dir}/${TURN_FILES.err}`);
  try {
    return await runIn(turn, p, dir, errFd, info.uid);
  } catch (e) {
    if (e instanceof Refusal) writeSync(errFd, `postbox runner: ${e.message}\n`);
    throw e;
  } finally {
    closeSync(errFd);
  }
}

/** @param {string} turn @param {ReturnType<typeof paths>} p @param {string} dir @param {number} errFd @param {number} owner */
async function runIn(turn, p, dir, errFd, owner) {
  const file = (/** @type {string} */ name) => `${dir}/${name}`;
  const uid = process.getuid?.();
  if (uid === 0) refuse('Postbox doesn’t run turns as root.');
  if (uid !== undefined && owner !== uid) refuse(`${dir} belongs to another user.`);
  chmodSync(dir, DIR_MODE); // the daemon makes it 0700; keep it so whatever made it

  let raw;
  try {
    const text = readFileSync(file(TURN_FILES.start), 'utf8');
    if (Buffer.byteLength(text) > START_MAX_BYTES) refuse(`start.json is over ${START_MAX_BYTES} bytes.`);
    raw = JSON.parse(text);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    refuse(`start.json can’t be read: ${/** @type {Error} */ (e).message}`);
  }
  const checked = validateStartRecord(raw);
  if (!checked.ok) refuse(checked.error);
  const s = checked.msg;
  if (s.turn !== turn) refuse(`start.json is for turn ${s.turn}, not ${turn}.`);
  // A second runner for a turn would mix two runs in one out.jsonl, or take a live runner’s socket.
  for (const f of [TURN_FILES.runner, TURN_FILES.exit]) if (existsSync(file(f))) refuse(`This turn has already run: ${f} is there.`);
  let isFolder = false;
  try {
    isFolder = statSync(s.folder).isDirectory();
  } catch {}
  if (!isFolder) refuse(`The work folder ${s.folder} isn’t there.`);
  const sock = file(TURN_FILES.socket);
  if (!socketPathFits(sock)) refuse(`The socket path ${sock} is too long for a Unix socket.`);
  clearStale(sock);

  /** @type {number | 'ignore' | 'pipe'} */
  let stdin = 'ignore';
  if (s.stdin === 'file') {
    try {
      stdin = openSync(file(MESSAGE_FILE), 'r');
    } catch {
      refuse(`The turn’s message file, ${MESSAGE_FILE}, isn’t there.`);
    }
  } else if (s.stdin === 'held') stdin = 'pipe';

  const rec = validateRunnerRecord({ turn, version: hostVersion(), pid: process.pid, bootId: bootId(), startTime: startTime(process.pid) });
  if (!rec.ok) refuse(`This host doesn’t give what runner.json needs: ${rec.error}`);
  writeAtomic(file(TURN_FILES.runner), `${JSON.stringify(rec.msg)}\n`);

  const outFd = openAppend(file(TURN_FILES.out));
  const inFd = s.stdin === 'held' ? openAppend(file(TURN_FILES.in)) : null;
  const server = await listen(sock);

  // Straight after listening, in the same task: no connection is handled before the harness exists.
  const child = childProcess.spawn(s.program, s.argv, { cwd: s.folder, env: { ...process.env, ...s.env }, detached: false, stdio: [stdin, outFd, errFd] });
  if (typeof stdin === 'number') closeSync(stdin);
  const pipe = child.stdin;
  let pipeOpen = !!pipe;
  pipe?.on('error', () => {
    pipeOpen = false; // EPIPE: the harness closed its stdin or exited
  });
  const closePipe = () => {
    if (!pipeOpen) return;
    pipeOpen = false;
    pipe?.end();
  };
  process.on('SIGINT', closePipe);
  process.on('SIGTERM', closePipe);

  /** @type {Set<import('node:net').Socket>} */
  const conns = new Set();
  server.on('connection', (conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    conn.on('error', () => {});
    serve(conn, { turn, tokenPath: p.token, inFd, pipe: () => (pipeOpen ? pipe : null) });
  });

  /** @type {{ code: number | null, signal: string | null }} */
  const how = await new Promise((resolve) => {
    let done = false;
    const finish = (/** @type {number | null} */ code, /** @type {string | null} */ signal) => {
      if (done) return;
      done = true;
      resolve({ code, signal });
    };
    child.on('exit', (code, signal) => finish(code, signal));
    child.on('error', (e) => {
      if (child.pid !== undefined) return; // a failed kill; the harness is still running
      writeSync(errFd, `postbox runner: ${s.program} didn’t start: ${e.message}\n`);
      finish(/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' ? NOT_FOUND : NOT_RUNNABLE, null);
    });
  });

  pipeOpen = false;
  pipe?.destroy();
  closeSync(outFd);
  if (inFd !== null) closeSync(inFd);
  const exit = validateExitRecord({ code: how.code, signal: how.signal, at: Date.now() });
  if (!exit.ok) throw new Error(exit.error);
  writeAtomic(file(TURN_FILES.exit), `${JSON.stringify(exit.msg)}\n`);

  await new Promise((resolve) => {
    server.close(() => resolve(undefined));
    for (const c of conns) c.destroy();
  });
  removeSocket(sock);
  process.off('SIGINT', closePipe);
  process.off('SIGTERM', closePipe);
  return exit.msg;
}

/** Removes the socket file if it’s there, and only if it’s a socket. @param {string} path */
function removeSocket(path) {
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path);
  } catch {}
}

/** Removes a socket a runner left behind, such as one that was killed; refuses anything else at that path. @param {string} path */
function clearStale(path) {
  /** @type {import('node:fs').Stats | null} */
  let old = null;
  try {
    old = lstatSync(path);
  } catch {}
  if (old && !old.isSocket()) refuse(`${path} is there and isn’t a socket.`);
  if (old) unlinkSync(path);
}

/** Listens on the turn’s socket, 0600. @param {string} path */
async function listen(path) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  server.on('error', () => {});
  // The umask already made it 0600; this keeps it so whatever the umask was. A socket can’t be opened, so it’s by
  // path, which nobody else can swap inside the 0700 folder.
  chmodSync(path, FILE_MODE);
  return server;
}

/**
 * Answers one daemon connection: `who` with the token gets `iam`; after that, `stdin` lines for a held stdin.
 * @param {import('node:net').Socket} conn
 * @param {{ turn: string, tokenPath: string, inFd: number | null, pipe: () => import('node:stream').Writable | null }} ctx
 */
function serve(conn, { turn, tokenPath, inFd, pipe }) {
  let trusted = false;
  const send = (/** @type {string} */ type, /** @type {Record<string, unknown>} */ body) => {
    if (conn.writable) conn.write(encode(message('runner-to-daemon', type, body)));
  };
  /** @param {string} code @param {string} text @param {string} [re]  the type of the message it answers */
  const fail = (code, text, re) => send('error', { code, message: text, turn, ...(re ? { re } : {}) });
  /** @param {{ type: string, [k: string]: any }} msg */
  async function handle(msg) {
    if (msg.type === 'who') {
      if (!tokenMatches(tokenPath, msg.token)) {
        fail('bad-token', 'That isn’t the host’s token.', 'who');
        conn.end();
        return;
      }
      trusted = true;
      send('iam', { turn, pid: process.pid });
      return;
    }
    if (!trusted) return fail('not-ready', 'Send who with the token first.', 'stdin');
    if (inFd === null) return fail('not-held', 'This turn’s stdin isn’t held.', 'stdin');
    const out = pipe();
    if (!out) return fail('turn-ended', 'The harness’s stdin is closed.', 'stdin');
    const line = `${msg.line}\n`;
    writeSync(inFd, line);
    const upTo = fstatSync(inFd).size;
    const ok = await new Promise((resolve) => out.write(line, (err) => resolve(!err)));
    if (!ok) return fail('turn-ended', 'The harness’s stdin closed before the line reached it.', 'stdin');
    send('written', { upTo });
  }
  // One message at a time, in order: a line is in in.jsonl and in the pipe before the next is looked at.
  let queue = Promise.resolve();
  const reader = createMessageReader('daemon-to-runner', {
    onMessage(msg) {
      queue = queue.then(() => handle(msg)).catch(() => void conn.destroy());
    },
    onError(e) {
      queue = queue.then(() => fail('bad-message', e.message));
    },
  });
  conn.on('data', (chunk) => reader.push(chunk));
  conn.on('end', () => reader.end());
}

// ── Starting a runner, for the daemon ────────────────────────────────────────────────

/**
 * What logind does at logout, or null for what it doesn’t say (no systemd, no logind, a command that failed).
 * @typedef {{ killUserProcesses: boolean | null, linger: boolean | null }} LogindFacts
 */

/** @param {string} file @param {string[]} args */
const runQuiet = (file, args) => childProcess.execFileSync(file, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * Reads logind’s settings. KillUserProcesses is the login manager’s D-Bus property (org.freedesktop.login1(5)), which
 * busctl prints as `b true`; it reflects logind.conf and its drop-ins as logind applied them, which reading the files
 * wouldn’t. Linger is `loginctl show-user`’s, which a probe on a real host printed as `Linger=yes` (C9: loginctl(1)
 * doesn’t list it).
 * @param {{ run?: (file: string, args: string[]) => string, uid?: number }} [opts]
 * @returns {LogindFacts}
 */
export function logindFacts({ run = runQuiet, uid = process.getuid?.() ?? -1 } = {}) {
  const out = (/** @type {string} */ file, /** @type {string[]} */ args) => {
    try {
      return run(file, args);
    } catch {
      return '';
    }
  };
  const kill = out('busctl', [
    'get-property',
    'org.freedesktop.login1',
    '/org/freedesktop/login1',
    'org.freedesktop.login1.Manager',
    'KillUserProcesses',
  ]).trim();
  const linger = /^Linger=(yes|no)$/m.exec(uid < 0 ? '' : out('loginctl', ['show-user', String(uid), '--property=Linger']))?.[1];
  return {
    killUserProcesses: kill === 'b true' ? true : kill === 'b false' ? false : null,
    linger: linger === 'yes' ? true : linger === 'no' ? false : null,
  };
}

/**
 * Starts a turn’s runner: `<node> runner.mjs <turn>`, detached so it leads its own session and process group, with
 * no stdio, and unref’d so the daemon can exit before it. Where logind kills a user’s processes at logout, it goes
 * into a systemd user scope too (`detach: 'auto'`). `systemd-run --scope` registers the scope and then execs the
 * command in its own process, so the runner keeps that PID and still leads the session. start.json must already be written.
 * @param {{ node: string, turn: string, paths?: ReturnType<typeof paths>, scope?: 'auto' | 'setsid',
 *   spawn?: typeof childProcess.spawn, logind?: () => LogindFacts }} opts
 *   scope: the host’s `detach` setting. logind: logindFacts, injected; the daemon may pass one that caches.
 * @returns {{ pid: number, scoped: boolean, lingerOff: boolean }}
 *   lingerOff: logind says lingering is off for this user. A scoped runner then ends at the person’s last logout, which
 *   the daemon warns about (C9).
 */
export function launchRunner({ node, turn, paths: p = paths(), scope = 'auto', spawn = childProcess.spawn, logind = logindFacts }) {
  const cwd = p.turn(turn);
  const facts = scope === 'auto' ? logind() : { killUserProcesses: null, linger: null };
  const scoped = facts.killUserProcesses === true;
  const command = [...(scoped ? ['systemd-run', '--user', '--scope', '--quiet', '--'] : []), node, PROGRAMS.runner, turn];
  // The turn folder as its working folder, not the version’s code folder, which retiring a version deletes.
  const child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // a spawn that failed has no pid, which is thrown below
  if (child.pid === undefined) throw new Error(`${command[0]} didn’t start.`);
  child.unref();
  return { pid: child.pid, scoped, lingerOff: facts.linger === false };
}

// ── Talking to a runner, for the daemon ──────────────────────────────────────────────

/** The host’s token, from its file. @param {string} path */
const readToken = (path) => readFileSync(path, 'utf8').trim();

/**
 * Sends messages over a runner’s socket and resolves with what `until` returns for the first reply it doesn’t
 * return undefined for. Rejects on an error reply, a closed socket, the timeout, or what `until` throws. `until` may
 * send more with its second argument.
 * @template T
 * @param {string} socketPath @param {object[]} msgs
 * @param {(msg: { type: string, [k: string]: any }, write: (msg: object) => void) => T | undefined} until @param {number} timeoutMs
 * @returns {Promise<T>}
 */
function converse(socketPath, msgs, until, timeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = createConnection({ path: socketPath });
    const done = (/** @type {() => void} */ settle) => {
      clearTimeout(timer);
      conn.destroy();
      settle();
    };
    const timer = setTimeout(() => done(() => reject(new Error('The runner didn’t answer in time.'))), timeoutMs);
    timer.unref();
    const reader = createMessageReader('runner-to-daemon', {
      onMessage(msg) {
        if (msg.type === 'error') return done(() => reject(Object.assign(new Error(msg.message), { code: msg.code })));
        let v;
        try {
          v = until(msg, (m) => conn.write(encode(m)));
        } catch (e) {
          return done(() => reject(e));
        }
        if (v !== undefined) done(() => resolve(v));
      },
      onError: (e) => done(() => reject(new Error(e.message))),
    });
    conn.on('connect', () => conn.write(msgs.map(encode).join('')));
    conn.on('data', (chunk) => reader.push(chunk));
    conn.on('error', (e) => done(() => reject(e)));
    conn.on('close', () => done(() => reject(new Error('The runner closed its socket.'))));
  });
}

/**
 * Whether a live runner for this turn answers on the socket: `who` gets `iam` with the turn’s ID. False for no
 * socket, no answer, another turn or a refused token.
 * @param {string} socketPath @param {string} turn
 * @param {{ timeoutMs?: number, token?: string }} [opts]  token: the host’s, read from its file if not given
 */
export async function askRunner(socketPath, turn, { timeoutMs = 2000, token } = {}) {
  try {
    const who = message('daemon-to-runner', 'who', { token: token ?? readToken(paths().token) });
    return await converse(socketPath, [who], (m) => (m.type === 'iam' ? m.turn === turn : undefined), timeoutMs);
  } catch {
    return false;
  }
}

/**
 * Writes one line to a held stdin, and resolves with in.jsonl’s size once it’s there and in the pipe. Rejects with
 * the runner’s error (its `code` is one of ERROR_CODES), for no answer, or, given `turn`, when the runner’s `iam`
 * names another turn, before the line is sent.
 * @param {string} socketPath @param {string} line  without its \n
 * @param {{ timeoutMs?: number, token?: string, turn?: string }} [opts]
 * @returns {Promise<number>}
 */
export function sendStdin(socketPath, line, { timeoutMs = 10_000, token, turn } = {}) {
  const who = message('daemon-to-runner', 'who', { token: token ?? readToken(paths().token) });
  const stdin = message('daemon-to-runner', 'stdin', { line });
  // Without a turn to check, both go at once (the runner takes them in order); with one, stdin waits for the iam.
  return converse(
    socketPath,
    turn === undefined ? [who, stdin] : [who],
    (m, write) => {
      if (m.type === 'iam' && turn !== undefined) {
        if (m.turn !== turn) throw new Error(`The runner’s socket answered for turn ${m.turn}, not ${turn}.`);
        write(stdin);
      }
      return m.type === 'written' ? m.upTo : undefined;
    },
    timeoutMs,
  );
}

// ── As a program ────────────────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  // Ignored from the start: the daemon’s Stop reaches the harness through the group, and the runner records it.
  for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.on(sig, () => {});
  runTurn(process.argv[2] ?? '').then(
    () => process.exit(0),
    (e) => {
      if (!(e instanceof Refusal)) {
        // Not a refusal, so not in err.log yet: a bad turn ID, or a fault after the harness started.
        try {
          const dir = paths().turn(process.argv[2] ?? '');
          writeFileSync(`${dir}/${TURN_FILES.err}`, `postbox runner: ${e?.message ?? e}\n`, { flag: 'a', mode: FILE_MODE });
        } catch {}
      }
      process.exit(1);
    },
  );
}
