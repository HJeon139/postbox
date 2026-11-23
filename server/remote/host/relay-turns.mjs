// Which of a host’s turns run under another Postbox version, and where that version’s daemon listens (#759,
// designs/759-adopt-old-turns.md). relay.mjs relays those turns to that daemon; the daemon’s own broker leaves them
// to it, since their shims talk only to their own version’s daemon.

import { promises as fsp } from 'node:fs';
import { posix } from 'node:path';
import { hostPaths, TURN_FILES } from '../../../shared/remote-protocol.mjs';
import { scan } from './daemon-scan.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon */

/**
 * The turns of `turns` this daemon’s broker serves: all but those whose runner.json names another version. One with
 * no runner record yet is its own: only this version starts turns now. Replaying another version’s records here would
 * send its calls and prompts to Postbox with no way back to its shim.
 * @template {{ turn: string }} T @param {Daemon} d @param {T[]} turns @returns {Promise<T[]>}
 */
export async function ownTurns(d, turns) {
  const own = [];
  for (const t of turns) {
    const version = await namedVersion(d, t.turn);
    if (version === null || version === d.version) own.push(t);
  }
  return own;
}

/**
 * The version a turn’s runner.json names, or null when it names none Postbox installs. Only the version is read, not
 * the whole record: an older version’s record may have a shape this one’s check refuses, and that turn is still that
 * version’s, to relay. hostPaths refuses a name that isn’t a version, so it can never become a path.
 * @param {Daemon} d @param {string} turn
 */
async function namedVersion(d, turn) {
  try {
    const r = JSON.parse(await fsp.readFile(d.p.turn(turn, TURN_FILES.runner), 'utf8'));
    if (typeof r?.version !== 'string') return null;
    hostPaths(d.home, r.version);
    return r.version;
  } catch {
    return null;
  }
}

/** The running turns under another version, by version. @param {Daemon} d */
export async function olderTurns(d) {
  /** @type {Map<string, string[]>} */
  const byVersion = new Map();
  for (const t of await scan(d)) {
    if (t.state !== 'running') continue;
    const version = await namedVersion(d, t.turn);
    if (version && version !== d.version) byVersion.set(version, [...(byVersion.get(version) ?? []), t.turn]);
  }
  return byVersion;
}

/** Those of `turns` the scan lists as ended or interrupted. @param {Daemon} d @param {Iterable<string>} turns */
export async function stopped(d, turns) {
  const over = new Set((await scan(d)).filter((t) => t.state !== 'running').map((t) => t.turn));
  return [...turns].filter((t) => over.has(t));
}

/**
 * An older version’s socket, if it’s a Unix socket inside this account’s own ~/.postbox-remote; else null.
 * @param {Daemon} d @param {string} version
 */
export async function socketOf(d, version) {
  let path;
  try {
    path = hostPaths(d.home, version).socket;
  } catch {
    return null;
  }
  try {
    if (!(await fsp.lstat(path)).isSocket()) return null;
    const [real, root] = await Promise.all([fsp.realpath(path), fsp.realpath(d.p.root)]);
    return real.startsWith(`${root}${posix.sep}`) ? path : null;
  } catch {
    return null;
  }
}
