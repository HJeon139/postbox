// The runner itself (runner.mjs’s header, #120): one turn, from start.json to exit.json. runner.mjs runs it as a
// program; runner-serve.mjs answers the daemon on the turn’s socket while it runs.

import childProcess from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer } from 'node:net';
import {
  DIR_MODE,
  FILE_MODE,
  MESSAGE_FILE,
  REMOTE_LIMITS,
  socketPathFits,
  TURN_FILES,
  validateExitRecord,
  validateRunnerRecord,
  validateStartRecord,
} from '../../../shared/remote-protocol.mjs';
import { hostVersion, paths } from './paths.mjs';
import { bootId, startTime } from './proc.mjs';
import { serve } from './runner-serve.mjs';

/** start.json is argv and env, each bounded well below this. */
const START_MAX_BYTES = 4 * REMOTE_LIMITS.argvBytes;
/** Exit codes for a harness that never started, as a shell reports them: not found, and found but not runnable. */
const NOT_FOUND = 127;
const NOT_RUNNABLE = 126;

/** A turn the runner won’t start; its message is the line for err.log. */
export class Refusal extends Error {}

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
  const { s, sock } = checkTurn(turn, dir, owner, file);
  const stdin = openStdin(s, file);

  const rec = validateRunnerRecord({ turn, version: hostVersion(), pid: process.pid, bootId: bootId(), startTime: startTime(process.pid) });
  if (!rec.ok) refuse(`This host doesn’t give what runner.json needs: ${rec.error}`);
  writeAtomic(file(TURN_FILES.runner), `${JSON.stringify(rec.msg)}\n`);

  const outFd = openAppend(file(TURN_FILES.out));
  const inFd = s.stdin === 'held' ? openAppend(file(TURN_FILES.in)) : null;
  const server = await listen(sock);

  // Straight after listening, in the same task: no connection is handled before the harness exists.
  const h = startHarness(s, stdin, outFd, errFd);
  const conns = serveConns(server, { turn, tokenPath: p.token, inFd, pipe: h.pipe });
  const how = await harnessExit(h.child, s, errFd);

  h.drop();
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
  h.unhook();
  return exit.msg;
}

/**
 * The checks before anything runs: the turn folder’s owner, start.json, that the turn hasn’t run, its work folder and
 * its socket path. Returns start.json and the socket’s path, its stale socket cleared.
 * @param {string} turn @param {string} dir @param {number} owner @param {(name: string) => string} file
 */
function checkTurn(turn, dir, owner, file) {
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
  return { s, sock };
}

/**
 * The harness’s stdin: the message file, a pipe for a held stdin, or nothing.
 * @param {{ stdin: string }} s @param {(name: string) => string} file @returns {number | 'ignore' | 'pipe'}
 */
function openStdin(s, file) {
  /** @type {number | 'ignore' | 'pipe'} */
  let stdin = 'ignore';
  if (s.stdin === 'file') {
    try {
      stdin = openSync(file(MESSAGE_FILE), 'r');
    } catch {
      refuse(`The turn’s message file, ${MESSAGE_FILE}, isn’t there.`);
    }
  } else if (s.stdin === 'held') stdin = 'pipe';
  return stdin;
}

/**
 * Starts the harness from start.json, never through a shell. A held stdin closes on SIGINT or SIGTERM (the header).
 * Returns the child, the held pipe while it’s open, and how to let it go once the harness exits.
 * @param {{ program: string, argv: string[], env: Record<string, string>, folder: string }} s
 * @param {number | 'ignore' | 'pipe'} stdin @param {number} outFd @param {number} errFd
 */
function startHarness(s, stdin, outFd, errFd) {
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
  return {
    child,
    pipe: () => (pipeOpen ? pipe : null),
    drop() {
      pipeOpen = false;
      pipe?.destroy();
    },
    unhook() {
      process.off('SIGINT', closePipe);
      process.off('SIGTERM', closePipe);
    },
  };
}

/**
 * Serves each daemon connection on the turn’s socket (runner-serve.mjs); returns the open ones, for the end.
 * @param {import('node:net').Server} server @param {Parameters<typeof serve>[1]} ctx
 */
function serveConns(server, ctx) {
  /** @type {Set<import('node:net').Socket>} */
  const conns = new Set();
  server.on('connection', (conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    conn.on('error', () => {});
    serve(conn, ctx);
  });
  return conns;
}

/**
 * How the harness ended: its exit, or the shell’s codes for one that never started.
 * @param {import('node:child_process').ChildProcess} child @param {{ program: string }} s @param {number} errFd
 * @returns {Promise<{ code: number | null, signal: string | null }>}
 */
function harnessExit(child, s, errFd) {
  return new Promise((resolve) => {
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
