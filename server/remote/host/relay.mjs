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
//   refuses any field it doesn’t know. It’s the same for each of a daemon’s relays, so a relay opened again replaces
//   the one before it. A daemon never relays from such a connection, so two versions can’t loop.
// - Up, only tool, prompt, prompt-expired and an error that names a turn, each only for the relay’s own turns. Down,
//   only snapshot, snapshot-items, answer and reply, for those turns.
// - A relay is planned before the driver’s welcome and connects after it: Postbox sends each turn’s snapshot as soon
//   as it’s welcomed, and those for a relayed turn wait for the relay’s hello, then go to the older daemon.
// - The relay’s hello carries the driver’s settings, which an older daemon may refuse if it doesn’t know one; it then
//   says hello again without them, so its own defaults hold.
// - Each relay belongs to the driver it was opened for, and ends with it, or once none of its turns runs, so the older
//   daemon can idle out. Postbox hears `relay` for the turns it couldn’t relay (off) and for those whose relay dropped
//   after it carried anything (lost), so their turn says so, and a prompt that was open can’t wait on an answer that
//   won’t come.

import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { createConnection } from 'node:net';
import { createLineReader, encode, message, PROTOCOL_VERSION, parseLine } from '../../../shared/remote-protocol.mjs';
import { send } from './daemon-reply.mjs';
import { olderTurns, socketOf, stopped } from './relay-turns.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */
/**
 * @typedef {{ write: (line: string) => void, end: () => void }} RelayLink  one connection to an older daemon
 * @typedef {{ version: string, turns: Set<string>, driver: Conn, settings: Record<string, unknown> | null,
 *   link: RelayLink | null, waiting: string[] | null, ready: boolean, crossed: boolean, unread: Set<string>, done: boolean,
 *   timer: any }} Relay
 *   settings: the driver’s, for the hello, or null. link: once connected; waiting: Postbox’s lines for it until the
 *   older daemon welcomes it, then null: a line it can’t read before then would read as a refused hello. ready: the
 *   older daemon welcomed it; crossed: a frame of its went to Postbox, which may wait on it now. unread: its turns that
 *   sent a frame this daemon couldn’t read. timer: its next look at whether its turns still run.
 */

/** How a relay’s hello says what it is. */
export const RELAY_PREFIX = 'relay_';
/** How often a relay looks whether its turns still run, once Postbox no longer reads them. */
export const RELAY_CHECK_MS = 30_000;
const UP = new Set(['tool', 'prompt', 'prompt-expired', 'error']);
const DOWN = new Set(['snapshot', 'snapshot-items', 'answer', 'reply']);
/** Postbox’s lines a relay holds until its welcome: the snapshot and what follows it, far fewer in practice. */
const WAITING_MAX = 1000;
/** Each daemon’s relay instance, the same for all its relays: an older daemon takes a new relay’s hello as the same
 * Postbox back and replaces the old relay, rather than refusing it as busy while the old one is still closing. */
const instances = /** @type {WeakMap<Daemon, string>} */ (new WeakMap());
/** Each daemon’s latest plan: a hello that comes while an earlier one still scans wins. */
const plans = /** @type {WeakMap<Daemon, number>} */ (new WeakMap());

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
 * Before a driver’s welcome: a relay for each other version with a running turn here, which Postbox’s lines for those
 * turns now go to. Never for a relay’s own hello. Returns them, for connectRelays once the welcome has gone.
 * @param {Daemon} d @param {Conn} c  the driver @param {any} hello  its hello
 */
export async function planRelays(d, c, hello) {
  closeRelays(d);
  const plan = (plans.get(d) ?? 0) + 1;
  plans.set(d, plan);
  if (typeof c.instance === 'string' && c.instance.startsWith(RELAY_PREFIX)) return [];
  const byVersion = await olderTurns(d);
  if (c.closed || d.driver !== c || plans.get(d) !== plan) return [];
  return [...byVersion].map(([version, turns]) => planned(d, c, version, turns, hello?.settings ?? null));
}

/** @param {Daemon} d @param {Conn} c @param {string} version @param {string[]} turns @param {Record<string, unknown> | null} settings */
function planned(d, c, version, turns, settings) {
  /** @type {Relay} */
  const relay = {
    version,
    turns: new Set(turns),
    driver: c,
    settings,
    link: null,
    waiting: [],
    ready: false,
    crossed: false,
    unread: new Set(),
    done: false,
    timer: null,
  };
  d.relays.add(relay);
  for (const t of turns) d.relayed.set(t, relay);
  watch(d, relay);
  return relay;
}

/** After the welcome: each planned relay connects; one that can’t is off. @param {Daemon} d @param {Relay[]} relays */
export async function connectRelays(d, relays) {
  for (const relay of relays) await connectOrOff(d, relay);
}

/** @param {Daemon} d @param {Relay} relay */
async function connectOrOff(d, relay) {
  try {
    await connect(d, relay);
  } catch (e) {
    d.log(`A relay to Postbox ${relay.version} couldn’t connect: ${e.message}`);
    endRelay(d, relay, 'off');
  }
}

/** Connects a relay and says hello; Postbox hears `relay` off when it can’t. @param {Daemon} d @param {Relay} relay */
async function connect(d, relay) {
  const path = await socketOf(d, relay.version);
  const token = path
    ? await fsp.readFile(d.p.token, 'utf8').then(
        (t) => t.trim(),
        () => '',
      )
    : '';
  if (relay.done) return;
  if (!path || !token) return endRelay(d, relay, 'off');
  relay.link = d.connectRelay(path, {
    onLine: (text) => fromOlder(d, relay, text),
    onClose: () => relayClosed(d, relay),
  });
  if (!instances.has(d)) instances.set(d, `${RELAY_PREFIX}${randomBytes(20).toString('hex')}`);
  const hello = { version: PROTOCOL_VERSION, token, instance: instances.get(d) };
  relay.link.write(encode(message('postbox-to-daemon', 'hello', relay.settings ? { ...hello, settings: relay.settings } : hello)));
}

/**
 * Looks, now and then, whether the relay’s turns still run: one the scan lists as ended or interrupted is no longer
 * relayed. A turn the scan doesn’t list stays, since a scan that couldn’t read the folder lists none.
 * @param {Daemon} d @param {Relay} relay
 */
function watch(d, relay) {
  relay.timer = d.timers.setTimeout(async () => {
    if (relay.done) return;
    for (const t of await stopped(d, relay.turns)) relayedEnded(d, t);
    if (!relay.done) watch(d, relay);
  }, d.relayCheckMs);
}

/** A line from the older daemon. @param {Daemon} d @param {Relay} relay @param {string} text */
function fromOlder(d, relay, text) {
  if (relay.done) return;
  const r = parseLine('daemon-to-postbox', text);
  if (!r.ok) return unreadable(d, relay, text, r.error);
  const { type, ...body } = r.msg;
  if (!relay.ready && type === 'welcome') {
    relay.ready = true;
    for (const line of relay.waiting ?? []) relay.link?.write(line);
    relay.waiting = null;
    return;
  }
  // busy, version, bad-token or bad-message, the answer to the hello, names no turn: the older daemon stays as it is.
  // A broker frame may come before the welcome, since the older daemon makes the relay its driver before it answers
  // the hello: it goes on as any other.
  if (!relay.ready && type === 'error' && typeof body.turn !== 'string') return refused(d, relay, body.code);
  if (!UP.has(type) || typeof body.turn !== 'string' || !relay.turns.has(body.turn)) return;
  if (relay.driver.closed || d.driver !== relay.driver) return;
  relay.crossed = true;
  void send(relay.driver, type, body);
}

/**
 * A frame from the older daemon this one can’t read, as one whose shape changed between them: what it carried can’t
 * reach Postbox, so its turn, if it names one of the relay’s, is lost, once.
 * @param {Daemon} d @param {Relay} relay @param {string} text @param {string} error
 */
function unreadable(d, relay, text, error) {
  d.log(`A relay to Postbox ${relay.version} got a line it couldn’t read: ${error}`);
  let turn;
  try {
    turn = JSON.parse(text)?.turn;
  } catch {}
  if (typeof turn !== 'string' || !relay.turns.has(turn) || relay.unread.has(turn)) return;
  relay.unread.add(turn);
  if (!relay.driver.closed && d.driver === relay.driver) void send(relay.driver, 'relay', { turn, version: relay.version, state: 'lost' });
}

/**
 * The older daemon refused the relay’s hello. One it couldn’t read may carry a setting it doesn’t know: the relay
 * says hello again without them, with what Postbox sent meanwhile. Otherwise these turns can’t be relayed.
 * @param {Daemon} d @param {Relay} relay @param {string} code
 */
function refused(d, relay, code) {
  d.log(`Postbox ${relay.version}’s daemon refused a relay: ${code}.`);
  if (code !== 'bad-message' || !relay.settings) return endRelay(d, relay, relay.crossed ? 'lost' : 'off');
  const lines = relay.waiting;
  endRelay(d, relay, null);
  const again = planned(d, relay.driver, relay.version, [...relay.turns], null);
  again.crossed = relay.crossed;
  again.waiting = lines;
  void connectOrOff(d, again);
}

/** The older daemon’s connection ended: lost, once it carried anything, else off. @param {Daemon} d @param {Relay} relay */
function relayClosed(d, relay) {
  if (!relay.done) endRelay(d, relay, relay.ready || relay.crossed ? 'lost' : 'off');
}

/**
 * Ends a relay, and tells its driver, while it drives, which turns lost it or never had it.
 * @param {Daemon} d @param {Relay} relay @param {'off' | 'lost' | null} state
 */
function endRelay(d, relay, state) {
  if (relay.done) return;
  relay.done = true;
  d.timers.clearTimeout(relay.timer);
  d.relays.delete(relay);
  for (const t of relay.turns) if (d.relayed.get(t) === relay) d.relayed.delete(t);
  try {
    relay.link?.end();
  } catch {}
  if (!state || relay.driver.closed || d.driver !== relay.driver) return;
  for (const turn of relay.turns) void send(relay.driver, 'relay', { turn, version: relay.version, state });
}

/**
 * A relayed turn is over, so its relay no longer carries it, and a relay left with none ends: the older daemon then
 * idles out on its own schedule.
 * @param {Daemon} d @param {string} turn
 */
export function relayedEnded(d, turn) {
  for (const relay of [...d.relays]) {
    if (!relay.turns.delete(turn)) continue;
    if (d.relayed.get(turn) === relay) d.relayed.delete(turn);
    if (!relay.turns.size) endRelay(d, relay, null);
  }
}

/** Every relay ends, or every one of driver `c`’s: its driver is gone or replaced. @param {Daemon} d @param {Conn} [c] */
export function closeRelays(d, c) {
  for (const relay of [...d.relays]) if (!c || relay.driver === c) endRelay(d, relay, null);
}

/**
 * Postbox’s message for a relayed turn goes to its relay, or waits for its hello. Whether it did.
 * @param {Daemon} d @param {any} m
 */
export function toOlder(d, m) {
  const relay = typeof m.turn === 'string' ? d.relayed.get(m.turn) : undefined;
  if (!relay || !DOWN.has(m.type)) return false;
  const { type, ...body } = m;
  const line = encode(message('postbox-to-daemon', type, body));
  if (!relay.waiting) relay.link?.write(line);
  else if (relay.waiting.length < WAITING_MAX) relay.waiting.push(line);
  return true;
}
