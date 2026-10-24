// A remote turn’s life on the laptop (#120, the plan’s L5): what the runtime does for an agent whose persona runs on
// a host (persona.remote.hostId), between its adapter and the host’s daemon. The design is architecture.md, “Remote
// hosts” (“Turn states”, “Permission prompts while nobody is connected”, “Postbox’s tools on the host”); D2 decided
// when a turn resumes on its own. server/runtime.mjs calls it from deliver, its turn context, endTurn, stop and the
// permission cards, and owns everything else.
//
// - Before the adapter starts, the host has its welcome (the host manager’s ensureWelcome), and the runtime allocates
//   the host turn’s ID and keeps it on the session as se.remoteTurn = { hostId, turn, offset, ... }, so it survives a
//   restart. The conversation snapshot goes before the adapter’s `start` (the reading tools never find it missing),
//   again in full at each welcome, and as snapshot-items while the turn runs. An adapter that needs a second host turn
//   in one deliver gets it from ctx.remote.nextTurn(), which does the same for the new ID. The host is needed
//   (need(hostId, 'turn')) while any of its turns runs, so its link reconnects while one does.
// - The daemon’s `tool` and `prompt` are applied as the laptop’s MCP server applies a call (server/mcp.mjs): the same
//   tools, from toolsFor, and the same permission card, from requestPermission. Each is an identity, (turn, id), which
//   the daemon sends again after every hello until Postbox has answered it: a queued tool’s reply is kept on the
//   session, and a prompt’s answer on its card, so a repeat gets the same answer and is never applied twice.
// - A prompt nobody can answer any more (`prompt-expired`: the host’s permissionWaitMax, or the harness canceled the
//   call) marks its card expired or canceled. One the person already answered keeps its answer: the expiry raced the
//   answer, and the card says what the person chose. `error { re: 'prompt-expired', id }` is the daemon saying it couldn’t
//   write an expiry down: the card is marked ended.
// - Turn states, on se.remoteTurn.state: running, waiting (a card is open), hung, signin, interrupted, lost (the link
//   gave up while it ran: it’s attached again when the host is back) and done. Hung is no stdout line for the host’s
//   stallTimeout with no card open and, for an adapter whose sign of work is an open tool call
//   (capabilities.remote.work), no step running; time while the link is down doesn’t count. A hung turn is stopped
//   (the daemon sends SIGINT, then SIGKILL), and says so with the last line’s time.
// - Resuming (D2): after Interrupted, the turn resumes on its own once the host is back, with
//   ctx.remote.resumeInterrupted; after Sign-in needed, only when the host’s signInCheck passes, and with no check it
//   waits for the person (resume()). Either way the resumed turn starts with a line saying why the last one stopped.
//   Before a new turn on a host with a signInCheck, the check runs, and a failure is a warning, not a refusal.
// - After a Postbox restart, a turn that was running is attached again (ctx.remote.attach) once the host’s welcome
//   lists it, and replayed from the start into a fresh mapper; the partial reply from before is marked replaced. One
//   the welcome doesn’t list is Interrupted.
// - A turn Postbox asked its host to stop (Stop, archive, delete, removing the host, or one that ended here with its
//   runner maybe still there) may run on until the daemon says it’s over: its `ended`, a no-turn answer to the stop, or
//   a welcome that doesn’t list it running. Until then it’s kept on the session (remoteTurn.stopping, so a restart asks
//   again), the host is needed, so its link reconnects, and the stop goes again at each welcome. A turn given up
//   without its own Stop is in state `stopping` meanwhile, never `done`. Removing a host waits for these
//   (confirmStops), and renaming one refuses while any is left (busyOn).
// - A dropped channel and the one after it run on their own on the daemon, so a `start` written just before a drop may
//   still reach it, or be under way there, when the stop on the new channel comes. The daemon answers that stop once
//   it knows the turn won’t run: no-turn means it never will, since a start for a turn it was asked to stop first is
//   refused (turn-stopped, shared/remote-protocol.mjs). A welcome that doesn’t list such a turn, whose start was
//   written and never confirmed (no `started` or turn-exists; remoteTurn.stopping’s `unconfirmed`), says nothing yet:
//   the stop goes again, and its answer decides.

import { ended, stopped } from './turns-end.mjs';
import { onConnected, onHostMessage } from './turns-messages.mjs';
import { ask } from './turns-prompts.mjs';
import { cancel, keepsCard, restore } from './turns-restore.mjs';
import { checkStalls, onHostStatus, resume, tick } from './turns-resume.mjs';
import { hostOf, ON_HOST, TICK_MS } from './turns-shared.mjs';
import { flushSnapshots, onStoreEvent } from './turns-snapshot.mjs';
import { begin, prepare } from './turns-start.mjs';
import { busyOn, confirmStops } from './turns-stops.mjs';

export { AUTO_RESUMES, OFFSET_SAVE_MS, SIGN_IN_RECHECK_MS, SNAPSHOT_FLUSH_MS, STOPPED_TEXT, TICK_MS, whyLine } from './turns-shared.mjs';

/** @typedef {import('./hosts.mjs').HostManager} HostManager */
/** @typedef {import('./turns-shared.mjs').Live} Live */
/** @typedef {import('./turns-shared.mjs').Stop} Stop */

/**
 * The remote turns’ state, which the functions in server/remote/turns-*.mjs take first (as `rts`). The runtime, tests
 * and the host’s messages reach them through the methods below.
 */
export class RemoteTurns {
  /**
   * @param {any} rt  the Runtime
   * @param {{ hosts?: HostManager | null, now?: () => number, setTimer?: (fn: () => void, ms: number) => any,
   *   clearTimer?: (t: any) => void, tickMs?: number }} [o]  now and the timers are for tests
   */
  constructor(rt, { hosts = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, tickMs = TICK_MS } = {}) {
    this.rt = rt;
    this.hosts = hosts;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** @type {Map<string, Live>} sessionId → its running remote turn */
    this.live = new Map();
    /** @type {Map<string, Live>} host turn → the live turn it belongs to */
    this.byTurn = new Map();
    /** @type {Map<string, string>} host turn → session, for a turn being attached after a restart */
    this.restoring = new Map();
    /** @type {Map<string, any[]>} what came for a turn being attached, before its attach started */
    this.early = new Map();
    /** @type {Map<string, { refs: number, link: any, off: () => void }>} hosts Postbox needs now, with its listeners */
    this.needed = new Map();
    /** @type {Set<string>} tool calls being applied, (turn, id) */
    this.applying = new Set();
    /** @type {Set<string>} prompts that ended on the host, (turn, id): an answer for one isn’t sent */
    this.endedPrompts = new Set();
    /** @type {Map<string, { full: boolean, items: Map<string, Set<string>> }>} sessionId → snapshot changes to send */
    this.dirty = new Map();
    /** @type {any} */
    this.flushTimer = null;
    /** @type {Map<string, number>} sessionId → when its sign-in wait last ran the host’s check */
    this.checkedAt = new Map();
    /** @type {Map<string, Stop>} host turn → a stop not yet confirmed */
    this.stopping = new Map();
    this.closed = false;
    this.unsubscribe = rt.store.subscribe((/** @type {any} */ ev) => onStoreEvent(this, ev));
    // The manager emits 'status' with (hostId, status) when a host’s connection changes.
    this.onStatus = (/** @type {string} */ hostId, /** @type {any} */ status) => onHostStatus(this, hostId, status);
    hosts?.on?.('status', this.onStatus);
    this.tickTimer = hosts ? setInterval(() => this.tick(), tickMs) : null;
    this.tickTimer?.unref?.();
  }

  /** Stops the timers and listeners, as Postbox shuts down. Turns go on on their hosts. */
  close() {
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.flushTimer) this.clearTimer(this.flushTimer);
    this.unsubscribe?.();
    this.hosts?.off?.('status', this.onStatus);
    for (const h of this.needed.values()) h.off();
    this.needed.clear();
  }

  /** The host a persona runs on, or null for this computer. @param {any} persona */
  hostOf(persona) {
    return hostOf(persona);
  }

  /** Sessions with a turn on a host, running or being attached again (for removeHost). @param {string} hostId */
  sessionsOn(hostId) {
    return Object.values(this.rt.s.sessions)
      .filter((se) => se.remoteTurn?.hostId === hostId && (this.live.has(se.id) || ON_HOST.has(se.remoteTurn.state)))
      .map((se) => se.id);
  }

  // Each of these is a function of server/remote/turns-*.mjs, named for it.

  /** @param {any} turn @param {string} hostId @param {any} adapter */
  begin(turn, hostId, adapter) {
    return begin(this, turn, hostId, adapter);
  }

  /** @param {any} turn @param {any} ctx @param {any} message */
  prepare(turn, ctx, message) {
    return prepare(this, turn, ctx, message);
  }

  /** @param {any} turn @param {any} req */
  ask(turn, req) {
    return ask(this, turn, req);
  }

  /** @param {any} turn @param {any} err */
  ended(turn, err) {
    return ended(this, turn, err);
  }

  /** @param {any} turn @param {{ by?: string, why?: string }} [o] */
  stopped(turn, o) {
    return stopped(this, turn, o);
  }

  restore() {
    return restore(this);
  }

  /** @param {string} sessionId */
  resume(sessionId) {
    return resume(this, sessionId);
  }

  /** @param {any} it */
  keepsCard(it) {
    return keepsCard(this, it);
  }

  /** @param {string} sessionId */
  cancel(sessionId) {
    return cancel(this, sessionId);
  }

  /** @param {string} hostId @param {number} waitMs */
  confirmStops(hostId, waitMs) {
    return confirmStops(this, hostId, waitMs);
  }

  /** @param {string} hostId */
  busyOn(hostId) {
    return busyOn(this, hostId);
  }

  tick() {
    return tick(this);
  }

  checkStalls() {
    return checkStalls(this);
  }

  flushSnapshots() {
    return flushSnapshots(this);
  }

  /** @param {string} hostId @param {any} m */
  onHostMessage(hostId, m) {
    return onHostMessage(this, hostId, m);
  }

  /** @param {string} hostId @param {any} [welcome] */
  onConnected(hostId, welcome) {
    return onConnected(this, hostId, welcome);
  }
}
