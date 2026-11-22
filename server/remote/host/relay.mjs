// A host’s turns left under an older Postbox (#759, designs/759-adopt-old-turns.md). A turn started under version A
// keeps its shim on A’s daemon after version B is installed, and the laptop talks only to B’s. So after each Postbox
// hello, B connects to A’s daemon as Postbox would, with the host’s shared token, and relays that turn’s tool calls,
// prompts and answers. Reads, exits and Stop already work through B: they use the shared turn folder.
//
// - Only for turns B finds running whose runner.json names another version. A’s socket comes from hostPaths with that
//   version, and must be a Unix socket inside the account’s own ~/.postbox-remote. The token goes in the hello alone,
//   never in a log, an error or a forwarded frame.
// - The relay’s hello never takes over: A refuses it as busy while another Postbox drives it, and leaves it be.
// - A relay says so by its instance, RELAY_PREFIX and random hex, which every version takes, since an older daemon
//   refuses any field it doesn’t know. A daemon never relays from such a connection, so two versions can’t loop.
// - Up, only tool, prompt, prompt-expired and an error that names a turn, each only for the relay’s own turns. Down,
//   only snapshot, snapshot-items, answer and reply, for those turns.
// - Each relay belongs to the driver it was opened for, and ends with it. Postbox hears `relay` for the turns it
//   couldn’t relay (off) and for those whose relay dropped while it drove (lost), so their turn says so, and a prompt
//   that was open can’t wait on an answer that won’t come.

import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { createConnection } from 'node:net';
import { posix } from 'node:path';
import { createLineReader, encode, hostPaths, message, parseLine, PROTOCOL_VERSION, TURN_FILES } from '../../../shared/remote-protocol.mjs';
import { send } from './daemon-reply.mjs';
import { scan } from './daemon-scan.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */
/**
 * @typedef {{ write: (line: string) => void, end: () => void }} RelayLink  one connection to an older daemon
 * @typedef {{ version: string, turns: Set<string>, link: RelayLink, driver: Conn, ready: boolean, done: boolean }} Relay
 */

/** How a relay’s hello says what it is. */
export const RELAY_PREFIX = 'relay_';
const UP = new Set(['tool', 'prompt', 'prompt-expired', 'error']);
const DOWN = new Set(['snapshot', 'snapshot-items', 'answer', 'reply']);

/**
 * A connection to an older daemon’s socket, its lines to onLine, and onClose once it ends.
 * @param {string} path @param {{ onLine: (text: string) => void, onClose: () => void }} on @returns {RelayLink}
 */
export function connectSocket(path, { onLine, onClose }) {
  const socket = createConnection(path);
  const reader = createLineReader({ onLine, onError: () => socket.destroy() });
  socket.on('data', (b) => reader.push(b));
  socket.on('error', () => socket.destroy());
  socket.on('close', onClose);
  return { write: (line) => socket.write(line), end: () => socket.end() };
}

/**
 * After a driver’s hello: a relay for each other version with a running turn here. Never for a relay’s own hello.
 * @param {Daemon} d @param {Conn} c  the driver @param {any} hello  its hello
 */
export async function openRelays(d, c, hello) {
  closeRelays(d);
  if (typeof c.instance === 'string' && c.instance.startsWith(RELAY_PREFIX)) return;
  /** @type {Map<string, string[]>} */
  const byVersion = new Map();
  for (const t of await scan(d)) {
    if (t.state !== 'running') continue;
    const version = await runnerVersion(d, t.turn);
    if (version && version !== d.version) byVersion.set(version, [...(byVersion.get(version) ?? []), t.turn]);
  }
  if (c.closed || d.driver !== c) return;
  for (const [version, turns] of byVersion) await openRelay(d, c, hello, version, turns);
}

/** The version a turn’s runner.json names, or null. @param {Daemon} d @param {string} turn */
async function runnerVersion(d, turn) {
  try {
    const r = JSON.parse(await fsp.readFile(d.p.turn(turn, TURN_FILES.runner), 'utf8'));
    return typeof r?.version === 'string' ? r.version : null;
  } catch {
    return null;
  }
}

/**
 * An older version’s socket, if it’s a Unix socket inside this account’s own ~/.postbox-remote; else null.
 * @param {Daemon} d @param {string} version
 */
async function socketOf(d, version) {
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

/**
 * One relay to `version`’s daemon for `turns`. Postbox hears `relay` off for them when it can’t be opened.
 * @param {Daemon} d @param {Conn} c @param {any} hello @param {string} version @param {string[]} turns
 */
async function openRelay(d, c, hello, version, turns) {
  const off = () => (c.closed || d.driver !== c ? undefined : send(c, 'relay', { turns, state: 'off' }));
  const path = await socketOf(d, version);
  const token = path ? await fsp.readFile(d.p.token, 'utf8').then((t) => t.trim(), () => '') : '';
  if (!path || !token || c.closed || d.driver !== c) return off();
  /** @type {Relay} */
  const relay = { version, turns: new Set(turns), link: /** @type {any} */ (null), driver: c, ready: false, done: false };
  relay.link = d.connectRelay(path, {
    onLine: (text) => fromOlder(d, relay, text),
    onClose: () => relayClosed(d, relay),
  });
  d.relays.add(relay);
  const body = { version: PROTOCOL_VERSION, token, instance: `${RELAY_PREFIX}${randomBytes(20).toString('hex')}` };
  relay.link.write(encode(message('postbox-to-daemon', 'hello', hello?.settings ? { ...body, settings: hello.settings } : body)));
}

/** A line from the older daemon. @param {Daemon} d @param {Relay} relay @param {string} text */
function fromOlder(d, relay, text) {
  if (relay.done) return;
  const r = parseLine('daemon-to-postbox', text);
  if (!r.ok) return d.log(`A relay to Postbox ${relay.version} got a line it couldn’t read: ${r.error}`);
  const { type, ...body } = r.msg;
  if (!relay.ready) {
    if (type === 'welcome') {
      relay.ready = true;
      for (const t of relay.turns) d.relayed.set(t, relay);
      return;
    }
    // busy, version or bad-token: the older daemon stays as it is, and these turns can’t be relayed.
    d.log(`Postbox ${relay.version}’s daemon refused a relay: ${type === 'error' ? body.code : type}.`);
    return endRelay(d, relay, 'off');
  }
  if (!UP.has(type) || typeof body.turn !== 'string' || !relay.turns.has(body.turn)) return;
  if (!relay.driver.closed && d.driver === relay.driver) send(relay.driver, type, body);
}

/** The older daemon’s connection ended. @param {Daemon} d @param {Relay} relay */
function relayClosed(d, relay) {
  if (!relay.done) endRelay(d, relay, relay.ready ? 'lost' : 'off');
}

/**
 * Ends a relay, and tells its driver, while it drives, which turns lost it or never had it.
 * @param {Daemon} d @param {Relay} relay @param {'off' | 'lost' | null} state
 */
function endRelay(d, relay, state) {
  if (relay.done) return;
  relay.done = true;
  d.relays.delete(relay);
  for (const t of relay.turns) if (d.relayed.get(t) === relay) d.relayed.delete(t);
  try {
    relay.link.end();
  } catch {}
  if (state && !relay.driver.closed && d.driver === relay.driver) send(relay.driver, 'relay', { turns: [...relay.turns], state });
}

/** Every relay ends: its driver is gone or replaced. @param {Daemon} d */
export function closeRelays(d) {
  for (const relay of [...d.relays]) endRelay(d, relay, null);
}

/**
 * Postbox’s message for a relayed turn goes to its relay. Whether it did.
 * @param {Daemon} d @param {any} m
 */
export function toOlder(d, m) {
  const relay = typeof m.turn === 'string' ? d.relayed.get(m.turn) : undefined;
  if (!relay || !DOWN.has(m.type)) return false;
  const { type, ...body } = m;
  relay.link.write(encode(message('postbox-to-daemon', type, body)));
  return true;
}
