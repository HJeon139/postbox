// Which TCP ports a set of processes listen on, for the integration tests’ “no TCP listener” checks (#120, G2). macOS:
// lsof, by PID. Linux: each process’s socket inodes (/proc/<pid>/fd), looked up in /proc/net/tcp and tcp6, where state
// 0A is LISTEN; no tool needed. The parsing is pure and the reads go through a reader, so tests/listeners.test.mjs
// checks it on recorded output, under the guard, and the integration test runs it on the real processes.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';

export const LSOF = '/usr/sbin/lsof';
export const NET_TCP = ['/proc/net/tcp', '/proc/net/tcp6'];
/** The kernel’s TCP_LISTEN, as /proc/net/tcp prints a row’s st. */
const LISTEN = '0A';

/**
 * @typedef {object} Reader
 * @property {(args: string[]) => { status: number | null, stdout: string, stderr: string, error?: Error }} lsof lsof run with these arguments
 * @property {(pid: number) => string[]} links What each of a process’s file descriptors points at (`socket:[<inode>]`,
 *   `pipe:[…]`, a path); none once it’s gone.
 * @property {(file: string) => string | null} read A file’s text, or null if there’s no such file.
 */

/** @type {Reader} */
export const systemReader = {
  lsof: (args) => spawnSync(LSOF, args, { encoding: 'utf8' }),
  links: (pid) => {
    let fds = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      return [];
    }
    const out = [];
    for (const fd of fds) {
      try {
        out.push(readlinkSync(`/proc/${pid}/fd/${fd}`));
      } catch {} // closed between the listing and the read
    }
    return out;
  },
  read: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
};

/** Why this machine can’t list a process’s TCP listeners, or false. */
export const NO_LISTENERS =
  process.platform === 'darwin'
    ? !existsSync(LSOF) && `${LSOF} isn’t on this Mac, so a process’s TCP listeners can’t be listed`
    : process.platform === 'linux'
      ? !existsSync(NET_TCP[0]) && 'there’s no /proc/net/tcp, so a process’s TCP listeners can’t be listed'
      : 'lists TCP listeners only on macOS (lsof) and Linux (/proc/net/tcp)';

/** The LISTEN rows of `lsof -nP -iTCP -sTCP:LISTEN` output, without its header. @param {string} stdout @returns {string[]} */
export function lsofListeners(stdout) {
  return stdout.split('\n').filter((l) => l && !l.startsWith('COMMAND') && l.trimEnd().endsWith('(LISTEN)'));
}

/**
 * Socket inode → PID, from each process’s file descriptor targets. @param {Map<number, string[]>} links PID → targets
 * @returns {Map<string, number>}
 */
export function socketInodes(links) {
  const inodes = new Map();
  for (const [pid, targets] of links)
    for (const t of targets) {
      const m = /^socket:\[(\d+)\]$/.exec(t);
      if (m) inodes.set(m[1], pid);
    }
  return inodes;
}

/**
 * The rows of /proc/net/tcp or tcp6 (header first) in state 0A whose inode is one of these processes’, one line each.
 * Fields: sl, local_address, rem_address, st, tx:rx, tr:when, retrnsmt, uid, timeout, inode.
 * @param {string} text @param {string} file @param {Map<string, number>} inodes @returns {string[]}
 */
export function procListeners(text, file, inodes) {
  const out = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[3] === LISTEN && inodes.has(f[9])) out.push(`pid ${inodes.get(f[9])} listens on ${f[1]} (${file})`);
  }
  return out;
}

/**
 * The TCP sockets in LISTEN that these processes hold, one line each; none is [].
 * @param {number[]} pids @param {{ reader?: Reader, platform?: string }} [options] @returns {string[]}
 */
export function tcpListeners(pids, { reader = systemReader, platform = process.platform } = {}) {
  if (platform === 'darwin') {
    const r = reader.lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(',')]);
    if (r.error) throw r.error;
    // lsof exits 1 when it lists nothing.
    if (r.status !== 0 && r.status !== 1) throw new Error(`lsof exited ${r.status}: ${r.stderr}`);
    return lsofListeners(r.stdout);
  }
  const inodes = socketInodes(new Map(pids.map((pid) => [pid, reader.links(pid)])));
  const out = [];
  for (const file of NET_TCP) {
    const text = reader.read(file);
    if (text !== null) out.push(...procListeners(text, file, inodes));
  }
  return out;
}
