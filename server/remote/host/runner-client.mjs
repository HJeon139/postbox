// How the daemon starts a turn’s runner and talks to it (runner.mjs’s header, #120): launchRunner, with logindFacts
// for the systemd scope, and askRunner and sendStdin over the turn’s socket.

import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createMessageReader, encode, message } from '../../../shared/remote-protocol.mjs';
import { PROGRAMS, paths } from './paths.mjs';

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
