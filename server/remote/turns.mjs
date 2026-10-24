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

import { randomUUID } from 'node:crypto';
import { LIMITS } from '../../shared/limits.mjs';
import { encodedBytes, message as protocolMessage, REMOTE_LIMITS, TOOL_ROUTES } from '../../shared/remote-protocol.mjs';
import { defaultHostSettings } from '../../shared/remote-settings.mjs';
import { describePermission } from '../adapters/claude-stream.mjs';
import { offersBring } from '../side-threads.mjs';

/** How often running remote turns are checked for a stall, and sign-in waits for their check. */
export const TICK_MS = 30_000;
/** How long changes to the conversation gather before they go to the host as snapshot-items. */
export const SNAPSHOT_FLUSH_MS = 1000;
/** How often an acked offset is written to the session, at most; the turn’s end always writes it. */
export const OFFSET_SAVE_MS = 5000;
/** How often a turn waiting on the host’s sign-in runs signInCheck, besides when the host comes back. */
export const SIGN_IN_RECHECK_MS = 5 * 60_000;
/** Resumes in a row Postbox starts on its own after Interrupted, before it waits for the person. */
export const AUTO_RESUMES = 3;
/** Queued tool calls whose replies the session keeps, for the daemon’s repeats. */
const KEPT_REPLIES = 200;
const KEPT_REPLY_CHARS = 2000;
/** Messages held for a turn being attached after a restart, at most. */
const EARLY_MESSAGES = 500;

/** What the laptop says to a call from a stopped turn (server/mcp.mjs), word for word. */
export const STOPPED_TEXT = 'This call came from an agent turn that was stopped or has ended, so Postbox didn’t run it.';
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** What a card says when the host ended its prompt but couldn’t record that. */
const ENDED_TEXT = 'The host ended this prompt but couldn’t record it, so it can’t be answered any more.';
/** States in which a session’s remote turn is still on the host as far as Postbox knows. */
const ON_HOST = new Set(['running', 'waiting', 'lost']);
const key = (turn, id) => `${turn}\n${id}`;
const clock = (at) => new Date(at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

/** @typedef {import('./hosts.mjs').HostManager} HostManager */

/**
 * One running remote turn: the runtime’s turn (`rt`) and the host turns it ran as.
 * @typedef {{ sessionId: string, hostId: string, rt: any, link: any, hostTurns: Set<string>, current: string | null,
 *   work: string, signInError: Record<string, unknown> | null, lastEvent: number, signIn: boolean,
 *   exit: { code: number | null, signal: string | null } | null | undefined, hung: { at: number, text: string } | null,
 *   offset: number, offsetSaved: number, attach: boolean, started: boolean, startSent: boolean }} Live
 *   exit: the current host turn’s, from `ended` (null: interrupted), undefined until then; started: the daemon said
 *   `started` (or turn-exists) for it, or it’s attached; startSent: its `start` was written to a connected link
 */

/**
 * A stop Postbox is waiting on. unconfirmed: its start was written but never confirmed, so a welcome that doesn’t list
 * it may have come before the start reached the daemon (the header).
 * @typedef {{ sessionId: string, hostId: string, waiters: (() => void)[], unconfirmed: boolean }} Stop
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
    this.flushTimer = null;
    /** @type {Map<string, number>} sessionId → when its sign-in wait last ran the host’s check */
    this.checkedAt = new Map();
    /** @type {Map<string, Stop>} host turn → a stop not yet confirmed */
    this.stopping = new Map();
    this.closed = false;
    this.unsubscribe = rt.store.subscribe((ev) => this.onStoreEvent(ev));
    // The manager emits 'status' with (hostId, status) when a host’s connection changes.
    this.onStatus = (/** @type {string} */ hostId, /** @type {any} */ status) => this.hostStatus(hostId, status);
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
    const id = persona?.remote?.hostId;
    return typeof id === 'string' && id ? id : null;
  }

  /** Sessions with a turn on a host, running or being attached again (for removeHost). @param {string} hostId */
  sessionsOn(hostId) {
    return Object.values(this.rt.s.sessions)
      .filter((se) => se.remoteTurn?.hostId === hostId && (this.live.has(se.id) || ON_HOST.has(se.remoteTurn.state)))
      .map((se) => se.id);
  }

  // ── Starting a turn ─────────────────────────────────────────────────────────────────

  /**
   * Called by deliver, synchronously, for a persona on a host: the turn is remote from now on, so Stop treats it as
   * one, and the host is needed. prepare() does the rest before the adapter starts.
   * @param {any} turn @param {string} hostId @param {any} adapter
   */
  begin(turn, hostId, adapter) {
    const caps = adapter?.capabilities?.remote ?? null;
    /** @type {Live} */
    const live = {
      sessionId: turn.sessionId,
      hostId,
      rt: turn,
      link: null,
      hostTurns: new Set(),
      current: null,
      work: caps?.work ?? 'events',
      signInError: caps?.signInError ?? null,
      lastEvent: this.now(),
      signIn: false,
      exit: undefined,
      hung: null,
      offset: 0,
      offsetSaved: 0,
      attach: false,
      started: false,
      startSent: false,
    };
    turn.remote = live;
    this.live.set(turn.sessionId, live);
    this.needHost(hostId);
    return live;
  }

  /**
   * Everything a remote turn needs before its adapter starts: the host’s welcome, the turn’s ID (persisted) and the
   * snapshot. Fills ctx.remote, and returns the message to deliver, which starts with why the last turn stopped when
   * it’s a resume. message.attach (a host turn ID) attaches to that turn instead (after a restart).
   * @param {any} turn @param {any} ctx @param {any} message
   */
  async prepare(turn, ctx, message) {
    const rt = this.rt;
    const live = /** @type {Live} */ (turn.remote);
    const se = rt.s.sessions[turn.sessionId];
    const persona = ctx.persona;
    const adapter = rt.adapters.get(persona.backend);
    const host = rt.s.hosts?.[live.hostId];
    if (!adapter?.capabilities?.remote)
      throw new Error(
        `@${se.handle}’s backend (${persona.backend}) can’t run on a remote host. Choose Claude Code, Kiro CLI or Codex, or run it on this computer.`,
      );
    if (!host) throw new Error(`@${se.handle}’s host was removed, so this turn couldn’t start. Choose another host for it, or this computer.`);
    if (!this.hosts) throw new Error(`Postbox isn’t set up to reach remote hosts, so @${se.handle}’s turn on ${host.name} couldn’t start.`);
    const version = rt.config.build?.version;
    if (typeof version !== 'string' || !version) throw new Error('Postbox doesn’t know its own version, so it can’t find its code on the host.');
    const attach = typeof message.attach === 'string' ? message.attach : null;
    // A host renamed while turns still run over its old link: nothing new starts there, and nothing falls back to it.
    let welcome;
    let link;
    try {
      welcome = await this.hosts.ensureWelcome(live.hostId);
      link = this.hosts.link(live.hostId);
    } catch (e) {
      throw this.renamedBusy(e, live.hostId, se) ?? e;
    }
    if (ctx.signal.aborted) throw abortError();
    live.link = this.trackAcks(live, this.listen(live.hostId) ?? link);
    // A sign-in that’s run out shows before the turn, not at its first model request (the design, “Sign-in stays the
    // host’s”). It’s a warning: the check may be wrong, and the person decides.
    if (!attach) {
      const check = await this.signInCheck(live.hostId);
      if (ctx.signal.aborted) throw abortError();
      if (check && !check.ok)
        rt.notify(
          'blocking',
          se,
          `Sign-in on ${host.name} may have run out`,
          `The host’s sign-in check failed${check.code === null ? '' : ` (exit code ${check.code})`}, so @${se.handle}’s turn there may stop with “Sign-in needed”. Sign in on the host, then carry on.`,
          turn.threadId,
        );
    }
    const project = rt.s.projects[rt.s.threads[se.threadId]?.projectId] ?? null;
    const folder = project?.hostFolders?.[live.hostId] ?? `${welcome.home === '/' ? '' : welcome.home}/postbox-work/${persona.handle}`;
    const prior = se.remoteTurn ?? null;
    const resume = !attach && prior?.resume ? prior.resume : null;
    /** @type {import('../adapters/adapter.mjs').RemoteContext} */
    const remote = {
      link: live.link,
      welcome,
      settings: { ...defaultHostSettings(), ...host.settings },
      folder,
      version,
      nextTurn: async () => this.allocate(live, folder),
      // As server/mcp.mjs lists bring_to_conversation only for such a turn, so does the shim (shimArgs).
      bring: offersBring(rt, turn),
    };
    if (attach) {
      live.attach = true;
      this.adopt(live, attach);
      live.started = true;
      remote.attach = { turn: attach };
      if (this.restoring.delete(attach)) this.releaseHost(live.hostId);
      this.updateRemote(se.id, { state: 'running', rtTurn: turn.id, at: this.now() });
      for (const m of this.early.get(attach) ?? []) this.onHostMessage(live.hostId, m);
      this.early.delete(attach);
    } else {
      remote.turn = this.allocate(live, folder);
      if (resume?.why === 'interrupted') remote.resumeInterrupted = true;
    }
    ctx.remote = remote;
    if (!resume) return message;
    const line = whyLine(resume.why, host.name);
    return message.slash === true ? message : { ...message, context: [line, ...(message.context ?? [])] };
  }

  /**
   * The refusal for a turn that would start on a renamed host’s old destination (the host manager’s host-renamed-busy),
   * or null for any other error.
   * @param {any} e @param {string} hostId @param {any} se
   */
  renamedBusy(e, hostId, se) {
    if (e?.code !== 'host-renamed-busy') return null;
    const name = this.rt.s.hosts?.[hostId]?.name ?? 'Its host';
    const old = this.hosts?.destinationOf?.(hostId);
    const message = `${name} was renamed while Postbox still had turns running on ${old ?? 'its old address'}, so @${se.handle}’s turn didn’t start: it would have run on the old machine. Try again once those turns end.`;
    return Object.assign(new Error(message), { userMessage: message, code: e.code });
  }

  /** A new host turn for a live turn: its ID, persisted on the session, and its snapshot. @param {Live} live @param {string} folder */
  allocate(live, folder) {
    const id = randomUUID();
    this.adopt(live, id);
    const se = this.rt.s.sessions[live.sessionId];
    const prior = se?.remoteTurn ?? {};
    this.rt.updateSession(live.sessionId, {
      remoteTurn: {
        hostId: live.hostId,
        turn: id,
        offset: 0,
        rtTurn: live.rt.id,
        threadId: live.rt.threadId,
        folder,
        state: 'running',
        at: this.now(),
        autoResumes: prior.resume?.auto ? (prior.autoResumes ?? 0) : 0,
        replies: prior.replies ?? [],
        stopping: prior.stopping ?? [],
      },
    });
    this.sendSnapshot(live, id);
    return id;
  }

  /** @param {Live} live @param {string} id */
  adopt(live, id) {
    live.hostTurns.add(id);
    live.current = id;
    live.started = false;
    live.startSent = false;
    live.exit = undefined;
    live.offset = 0;
    live.offsetSaved = 0;
    this.byTurn.set(id, live);
  }

  /** The link as the adapter gets it: the host’s, with each ack it sends recorded as the turn’s offset. @param {Live} live @param {any} link */
  trackAcks(live, link) {
    return new Proxy(link, {
      get: (target, prop) => {
        if (prop === 'send')
          return (/** @type {any} */ msg) => {
            const ok = target.send(msg);
            if (ok && msg?.type === 'ack' && live.hostTurns.has(msg.turn)) this.offsetAt(live, msg.turn, msg.upTo);
            // Written to a channel that had its welcome: it may be on the host from now on, confirmed or not.
            if (ok && msg?.type === 'start' && msg.turn === live.current) live.startSent = true;
            return ok;
          };
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  /** @param {Live} live @param {string} turn @param {number} upTo @param {boolean} [now]  write it at once */
  offsetAt(live, turn, upTo, now = false) {
    if (turn !== live.current || upTo < live.offset) return;
    live.offset = upTo;
    if (!now && this.now() - live.offsetSaved < OFFSET_SAVE_MS) return;
    live.offsetSaved = this.now();
    const se = this.rt.s.sessions[live.sessionId];
    if (se?.remoteTurn?.turn === turn) this.updateRemote(se.id, { offset: upTo });
  }

  // ── The snapshot ───────────────────────────────────────────────────────────────────

  /**
   * The conversation as the session’s reading tools see it: its threads in conversationThreads’ order, each with the
   * items read_conversation pages through (every one counts, so one with no line is kept with an empty one), each with
   * its line and the full text read_message reads, in the runtime’s own words.
   * @param {any} se
   */
  snapshotOf(se) {
    const rt = this.rt;
    const threads = rt
      .conversationThreads(se.threadId)
      .slice(0, REMOTE_LIMITS.snapshotThreads)
      .map((/** @type {string} */ id) => ({ id, items: this.readable(id).map((/** @type {any} */ i) => this.itemOf(i, se)) }));
    return { home: se.threadId, threads: fit(threads) };
  }

  /** read_conversation’s items for a thread. @param {string} threadId */
  readable(threadId) {
    return this.rt.store
      .items(threadId)
      .filter((/** @type {any} */ i) => i.kind !== 'system' || i.variant === 'wake')
      .slice(-REMOTE_LIMITS.snapshotItems);
  }

  /** @param {any} i @param {any} se */
  itemOf(i, se) {
    const line = String(this.rt.readLine(i, se) ?? '').slice(0, REMOTE_LIMITS.snapshotLineChars);
    const text = String(this.rt.readLine(i, se, Number.POSITIVE_INFINITY) ?? '').slice(0, REMOTE_LIMITS.snapshotTextChars);
    return { id: i.id, line, text, ...(i.kind === 'block' && i.valid && typeof i.block?.id === 'string' ? { blockId: i.block.id } : {}) };
  }

  /** @param {Live} live @param {string} turn */
  sendSnapshot(live, turn) {
    const se = this.rt.s.sessions[live.sessionId];
    const link = live.link ?? this.hosts?.link(live.hostId);
    if (!se || !link) return false;
    const sent = send(link, 'snapshot', { turn, ...this.snapshotOf(se) });
    // Not sent: it goes in full at the next welcome.
    if (!sent) this.markDirty(live.sessionId, null, null);
    return sent;
  }

  /** @param {any} ev */
  onStoreEvent(ev) {
    if (!this.live.size) return;
    const d = ev.data ?? {};
    if (ev.type === 'item.add' || ev.type === 'item.patch' || ev.type === 'item.text') {
      const id = ev.type === 'item.add' ? d.item?.id : d.id;
      for (const live of this.live.values()) if (this.inConversation(live, d.threadId)) this.markDirty(live.sessionId, d.threadId, id);
    } else if (ev.type === 'item.move' || ev.type === 'thread') {
      // A moved item changes the order, and a new thread the list: snapshot-items can say neither, so it goes in full.
      const threadId = ev.type === 'thread' ? d.id : d.threadId;
      for (const live of this.live.values()) if (this.inConversation(live, threadId)) this.markDirty(live.sessionId, null, null);
    }
  }

  /** @param {Live} live @param {string} threadId */
  inConversation(live, threadId) {
    const se = this.rt.s.sessions[live.sessionId];
    if (!se || !threadId) return false;
    const root = (/** @type {string} */ id) => this.rt.lineage(id).at(-1);
    return root(threadId) === root(se.threadId);
  }

  /** @param {string} sessionId @param {string | null} threadId @param {string | null} itemId  null: all of it */
  markDirty(sessionId, threadId, itemId) {
    const d = this.dirty.get(sessionId) ?? { full: false, items: new Map() };
    this.dirty.set(sessionId, d);
    if (!threadId || !itemId) d.full = true;
    else {
      const set = d.items.get(threadId) ?? new Set();
      set.add(itemId);
      d.items.set(threadId, set);
    }
    if (!this.flushTimer && !this.closed) {
      this.flushTimer = this.setTimer(() => this.flushSnapshots(), SNAPSHOT_FLUSH_MS);
      this.flushTimer?.unref?.();
    }
  }

  /** Sends what changed in each live turn’s conversation: snapshot-items per thread, or the whole snapshot. */
  flushSnapshots() {
    this.flushTimer = null;
    const dirty = [...this.dirty];
    this.dirty.clear();
    for (const [sessionId, d] of dirty) {
      const live = this.live.get(sessionId);
      const se = this.rt.s.sessions[sessionId];
      if (!live?.current || !se) continue;
      if (d.full) {
        this.sendSnapshot(live, live.current);
        continue;
      }
      const threads = this.rt.conversationThreads(se.threadId);
      for (const [threadId, ids] of d.items) {
        if (!threads.includes(threadId)) continue;
        const items = this.readable(threadId)
          .filter((/** @type {any} */ i) => ids.has(i.id))
          .map((/** @type {any} */ i) => this.itemOf(i, se));
        if (items.length && !send(live.link, 'snapshot-items', { turn: live.current, thread: threadId, items })) this.markDirty(sessionId, null, null);
      }
    }
  }

  // ── The host’s messages ─────────────────────────────────────────────────────────────

  /** Postbox needs a host while a turn runs on it, or one is being attached: its link connects and is listened to. @param {string} hostId */
  needHost(hostId) {
    if (!this.hosts) return;
    const h = this.needed.get(hostId);
    if (h) {
      h.refs++;
      this.listen(hostId);
      return;
    }
    this.needed.set(hostId, { refs: 1, link: null, off: () => {} });
    try {
      this.hosts.need(hostId, 'turn');
    } catch (e) {
      // Postbox is closing its links: the turn’s prepare finds out, and says so.
      console.error(`Postbox couldn’t keep a host connected for a turn: ${e.message}`);
    }
    this.listen(hostId);
  }

  /**
   * Listens to the link the manager has for the host now. A host that isn’t installed (or was removed) has none yet:
   * the turn’s prepare says why. One installed since, or again with another token, has a new link, listened to from
   * the next turn’s prepare.
   * @param {string} hostId
   */
  listen(hostId) {
    const h = this.needed.get(hostId);
    if (!h) return null;
    /** @type {any} */
    let link = null;
    try {
      link = this.hosts?.link(hostId) ?? null;
    } catch (e) {
      // Renamed while turns run over the old link: they’re still heard on it, and nothing new gets it.
      if (e?.code === 'host-renamed-busy') return null;
      link = null;
    }
    if (link === h.link) return link;
    h.off();
    const onMessage = (/** @type {any} */ m) => this.onHostMessage(hostId, m);
    const onConnected = (/** @type {any} */ w) => this.onConnected(hostId, w);
    link?.on?.('message', onMessage);
    link?.on?.('connected', onConnected);
    h.link = link;
    h.off = () => {
      link?.off?.('message', onMessage);
      link?.off?.('connected', onConnected);
    };
    return link;
  }

  /** @param {string} hostId */
  releaseHost(hostId) {
    const h = this.needed.get(hostId);
    if (!h || --h.refs > 0) return;
    h.off();
    this.needed.delete(hostId);
    this.hosts?.release(hostId, 'turn');
  }

  /**
   * A welcome: the snapshot goes again in full, and the quiet clock starts again, since the link was down. A turn
   * asked to stop that the welcome lists ended or interrupted is over, and so is one it doesn’t list, unless its start
   * went unconfirmed (that start may still reach the daemon, from the channel that dropped). The rest are asked again.
   * @param {string} hostId @param {any} [welcome]
   */
  onConnected(hostId, welcome) {
    for (const live of this.live.values()) {
      if (live.hostId !== hostId || !live.current) continue;
      live.lastEvent = Math.max(live.lastEvent, this.now());
      this.sendSnapshot(live, live.current);
    }
    const w = welcome ?? this.hosts?.status(hostId)?.welcome ?? null;
    for (const [turn, s] of [...this.stopping]) {
      if (s.hostId !== hostId) continue;
      const listed = Array.isArray(w?.turns) ? w.turns.find((/** @type {any} */ t) => t.turn === turn) : undefined;
      if (Array.isArray(w?.turns) && listed?.state !== 'running' && (listed || !s.unconfirmed)) this.stopConfirmed(turn);
      else this.sendStop(turn);
    }
  }

  /** @param {string} hostId @param {any} m */
  onHostMessage(hostId, m) {
    if (typeof m?.turn !== 'string') return;
    // A turn being attached hears these once its attach has started, in the order they came.
    if (!this.byTurn.has(m.turn) && this.restoring.has(m.turn) && ['tool', 'prompt', 'prompt-expired', 'error'].includes(m.type)) {
      const list = this.early.get(m.turn) ?? [];
      if (list.length < EARLY_MESSAGES) list.push(m);
      this.early.set(m.turn, list);
      return;
    }
    switch (m.type) {
      case 'line':
        if (m.log !== 'in') this.sawLine(m);
        return;
      case 'ended':
        this.stopConfirmed(m.turn);
        return this.sawEnded(m);
      case 'started':
        return this.sawStarted(m.turn);
      case 'tool':
        return void this.onTool(hostId, m);
      case 'prompt':
        return this.onPrompt(hostId, m);
      case 'prompt-expired':
        return this.onPromptExpired(m);
      case 'error':
        // A start sent again that was there already: it reached the host.
        if (m.re === 'start' && m.code === 'turn-exists') this.sawStarted(m.turn);
        // The daemon has no such turn, and refuses its start from now on: one Postbox asked to stop won’t run there.
        if (m.re === 'stop' && m.code === 'no-turn') this.stopConfirmed(m.turn);
        return this.onError(m);
    }
  }

  /** The daemon has the turn: its start is confirmed, for the live turn and for a stop waiting on it. @param {string} turn */
  sawStarted(turn) {
    const live = this.byTurn.get(turn);
    if (live && turn === live.current) live.started = true;
    const s = this.stopping.get(turn);
    if (s?.unconfirmed) {
      s.unconfirmed = false;
      this.saveStop(s.sessionId, turn);
    }
  }

  /** A stdout line: a sign of life, and maybe the harness’s sign-in error. @param {any} m */
  sawLine(m) {
    const live = this.byTurn.get(m.turn);
    if (!live) return;
    live.lastEvent = this.now();
    if (live.signInError && !m.cut && matches(m.text, live.signInError)) live.signIn = true;
  }

  /** @param {any} m */
  sawEnded(m) {
    const live = this.byTurn.get(m.turn);
    if (!live) return;
    if (m.turn === live.current) live.exit = m.exit;
    this.offsetAt(live, m.turn, m.size, true);
  }

  /**
   * A shim tool call: applied through the same tools the laptop’s MCP server uses, and answered with `reply`.
   * @param {string} hostId @param {{ turn: string, id: string, name: string, args: Record<string, any> }} m
   */
  async onTool(hostId, m) {
    const k = key(m.turn, m.id);
    const link = this.linkOf(hostId);
    const se = this.sessionOfTurn(m.turn);
    const done = se?.remoteTurn?.replies?.find((/** @type {any} */ r) => r.turn === m.turn && r.id === m.id);
    if (done) return void send(link, 'reply', { turn: m.turn, id: m.id, ok: done.ok, text: done.text });
    if (this.applying.has(k)) return;
    const live = this.byTurn.get(m.turn);
    // A call from a turn that was stopped or has ended is refused, as on the laptop (#126).
    if (!live || live.rt.closed) return void send(link, 'reply', { turn: m.turn, id: m.id, ok: false, text: STOPPED_TEXT });
    this.applying.add(k);
    let r;
    try {
      r = await this.applyTool(live, m);
    } finally {
      this.applying.delete(k);
    }
    const text = r.text.slice(0, REMOTE_LIMITS.replyChars);
    // A queued call’s agent already has its answer (the shim’s), so its reply is kept for the daemon’s repeats, and
    // a failure goes to the agent at its next turn instead.
    if (TOOL_QUEUED.has(m.name)) {
      const now = this.rt.s.sessions[live.sessionId];
      if (now?.remoteTurn) {
        const replies = [...(now.remoteTurn.replies ?? []), { turn: m.turn, id: m.id, ok: r.ok, text: text.slice(0, KEPT_REPLY_CHARS) }].slice(-KEPT_REPLIES);
        this.updateRemote(now.id, { replies });
      }
      if (!r.ok) this.rt.tellAgent(live.sessionId, `Your ${m.name} call from the host didn’t go through: ${text.slice(0, 1000)}`);
    }
    send(link, 'reply', { turn: m.turn, id: m.id, ok: r.ok, text: text || (r.ok ? 'Done.' : 'It failed.') });
  }

  /** @param {Live} live @param {{ name: string, args: Record<string, any> }} m @returns {Promise<{ ok: boolean, text: string }>} */
  async applyTool(live, m) {
    const tools = this.rt.toolsFor(live.sessionId, live.rt);
    if (m.name === 'add_dataset')
      return {
        ok: false,
        text: 'add_dataset loads a file on Postbox’s computer, which an agent on a remote host can’t name, so it isn’t available there yet.',
      };
    if (!Object.hasOwn(tools, m.name)) return { ok: false, text: `There’s no tool called “${m.name}”.` };
    try {
      // show_app’s and update_app’s files were read on the host (the broker), and come as base64.
      const app = m.name === 'show_app' || m.name === 'update_app' ? await this.appFiles(m.args) : { args: m.args };
      const r = await tools[m.name](app.args, app.files ? { files: app.files } : {});
      return { ok: !(r.ok === false && !r.waiting), text: r.results ? JSON.stringify(r.results) : String(r.message ?? '') };
    } catch (e) {
      return { ok: false, text: String(e.userMessage ?? e.message) };
    }
  }

  /**
   * An app’s data files from the host: [{ name, base64 }], stored as the laptop stores the ones it reads (appFiles).
   * @param {Record<string, any>} args
   */
  async appFiles(args) {
    const { files, ...rest } = args ?? {};
    if (files === undefined) return { args: rest };
    const fail = (/** @type {string} */ text) => Object.assign(new Error(text), { userMessage: text });
    if (!Array.isArray(files)) throw fail('files is a list: [{ name?, path }].');
    if (files.length > LIMITS.appFiles) throw fail(`An app carries up to ${LIMITS.appFiles} data files.`);
    if (!this.rt.blobs) throw fail('This Postbox can’t store files.');
    /** @type {{ name: string, sha256: string, size: number }[]} */
    const stored = [];
    for (const f of files) {
      const name = String(f?.name ?? '');
      if (!FILE_NAME.test(name)) throw fail(`“${name}” can’t name a file: use letters, digits and - _ . (up to 64).`);
      if (stored.some((x) => x.name === name)) throw fail(`Two files are named “${name}”.`);
      if (typeof f.base64 !== 'string' || f.base64.length % 4 || !BASE64.test(f.base64)) throw fail(`The file “${name}” didn’t arrive whole from the host.`);
      const buf = Buffer.from(f.base64, 'base64');
      if (buf.length > LIMITS.appFileBytes) throw fail(`The file “${name}” is over the limit for an app’s data file.`);
      stored.push({ name, ...(await this.rt.blobs.put(buf)) });
    }
    return { args: rest, files: stored };
  }

  /**
   * A permission prompt waiting in the shim: the laptop’s card (requestPermission), answered with `answer`. A repeat
   * of one already answered gets the same answer again; one already showing waits on its card.
   * @param {string} hostId @param {{ id: string, turn: string, request: Record<string, any> }} m
   */
  onPrompt(hostId, m) {
    const k = key(m.turn, m.id);
    if (this.endedPrompts.has(k)) return;
    const link = this.linkOf(hostId);
    const card = this.cardOf(m.turn, m.id);
    if (card && card.it.status !== 'open') {
      if (card.it.remote?.answer) send(link, 'answer', { turn: m.turn, prompt: m.id, result: card.it.remote.answer });
      return;
    }
    const live = this.byTurn.get(m.turn);
    if (!live || live.rt.closed) {
      if (!card) send(link, 'answer', { turn: m.turn, prompt: m.id, result: { behavior: 'deny', message: 'The turn has ended.' } });
      return;
    }
    // Shown already: after a restart nothing waits on it here yet, so its answer is waited for again.
    if (card) {
      if (!this.rt.permissionWaits.has(card.it.id)) this.waitOn(live, card, m);
      return;
    }
    const { tool_name, input = {}, tool_use_id, permission_suggestions, agent_id } = m.request ?? {};
    const { summary, detail } = describePermission(String(tool_name ?? 'a tool'), input);
    const asked = this.ask(live.rt, {
      tool: String(tool_name ?? ''),
      summary,
      detail,
      toolUseId: tool_use_id ?? null,
      input,
      suggestions: permission_suggestions,
      agentId: typeof agent_id === 'string' ? agent_id : null,
      hostPrompt: { hostId, turn: m.turn, id: m.id },
    });
    asked.then((answer) => this.answered(hostId, m, answer, input));
  }

  /** A card shown before a restart, waited on again. @param {Live} live @param {{ threadId: string, it: any }} card @param {any} m */
  waitOn(live, card, m) {
    const rt = this.rt;
    const se = rt.s.sessions[live.sessionId];
    const p = new Promise((resolve) => rt.permissionWaits.set(card.it.id, { resolve, threadId: card.threadId, sessionId: live.sessionId }));
    rt.updateSession(live.sessionId, {
      state: 'needs',
      needs: { kind: 'permission', itemId: card.it.id, text: `@${se.handle} asks to ${card.it.summary}`, ...rt.awayFrom(se, card.threadId) },
    });
    this.setWaiting(live, true);
    p.then((answer) => {
      this.setWaiting(live, false);
      this.answered(live.hostId, m, /** @type {any} */ (answer), card.it.input ?? m.request?.input ?? {});
    });
  }

  /**
   * The person answered (or the turn ended first): the answer goes to the host, and onto the card for repeats,
   * unless the host ended the prompt meanwhile.
   * @param {string} hostId @param {{ id: string, turn: string }} m @param {any} answer @param {any} input
   */
  answered(hostId, m, answer, input) {
    if (this.endedPrompts.has(key(m.turn, m.id))) return;
    let result = answer?.allow
      ? {
          behavior: 'allow',
          updatedInput: answer.updatedInput ?? input,
          ...(answer.updatedPermissions ? { updatedPermissions: answer.updatedPermissions } : {}),
        }
      : { behavior: 'deny', message: String(answer?.message || 'The person didn’t allow this.').slice(0, REMOTE_LIMITS.messageChars) };
    try {
      protocolMessage('postbox-to-daemon', 'answer', { turn: m.turn, prompt: m.id, result });
    } catch {
      result = { behavior: 'deny', message: 'Postbox couldn’t send this answer to the host, so it didn’t allow it.' };
    }
    const card = this.cardOf(m.turn, m.id);
    if (card) this.rt.patchItem(card.threadId, card.it.id, { remote: { ...card.it.remote, answer: result } });
    send(this.linkOf(hostId), 'answer', { turn: m.turn, prompt: m.id, result });
  }

  /**
   * A card for a remote turn: requestPermission, with the card marked as the host prompt it answers, and the turn
   * shown as waiting while it’s open. hostPrompt: { hostId, turn, id }, or a string ID the adapter knows it by (a
   * Codex request’s, codex:<id>), in the turn’s current host turn.
   * @param {any} turn @param {any} req
   */
  ask(turn, req) {
    const live = /** @type {Live | undefined} */ (turn.remote);
    if (!live) return this.rt.requestPermission(turn.sessionId, req);
    const hp = req.hostPrompt;
    const hostPrompt = typeof hp === 'string' ? (live.current ? { hostId: live.hostId, turn: live.current, id: hp } : null) : (hp ?? null);
    this.setWaiting(live, true);
    const p = this.rt.requestPermission(turn.sessionId, { ...req, hostPrompt });
    return p.then((/** @type {any} */ a) => {
      this.setWaiting(live, false);
      return a;
    });
  }

  /** @param {Live} live @param {boolean} on */
  setWaiting(live, on) {
    const se = this.rt.s.sessions[live.sessionId];
    if (!se?.remoteTurn || live.rt.closed || !ON_HOST.has(se.remoteTurn.state)) return;
    const open = [...this.rt.permissionWaits.values()].some((w) => w.sessionId === live.sessionId);
    const state = on || open ? 'waiting' : 'running';
    if (se.remoteTurn.state !== state) this.updateRemote(se.id, { state });
  }

  /**
   * Nobody can answer a prompt any more: its card is marked expired (the host’s permissionWaitMax) or canceled (the
   * harness gave up on the call). A card the person already answered keeps its answer.
   * @param {{ id: string, turn: string, at: number, reason?: 'expired' | 'canceled' }} m
   */
  onPromptExpired(m) {
    const card = this.cardOf(m.turn, m.id);
    if (card && card.it.status !== 'open') return;
    this.endedPrompts.add(key(m.turn, m.id));
    if (!card) return;
    const canceled = m.reason === 'canceled';
    // noAnswer: the host’s permissionWaitMax ran out, which the card says, unlike an expiry when the turn ended.
    this.endCard(
      card,
      canceled ? 'canceled' : 'expired',
      canceled ? 'The agent stopped waiting for this answer.' : 'Nobody answered in time, so the host didn’t allow it.',
      m.at,
      canceled ? {} : { noAnswer: true },
    );
  }

  /** @param {any} m */
  onError(m) {
    // The daemon couldn’t write down that a prompt of this turn ended: it can’t be answered any more. The error names
    // the prompt (its id), so exactly that card is marked ended; one from a daemon that doesn’t name it marks a lone
    // open card only, since nothing says which when more than one is open. A card already answered keeps its answer.
    if (m.re === 'prompt-expired' && typeof m.turn === 'string') {
      if (typeof m.id === 'string') {
        const card = this.cardOf(m.turn, m.id);
        if (card && card.it.status !== 'open') return;
        this.endedPrompts.add(key(m.turn, m.id));
        if (card) this.endCard(card, 'ended', ENDED_TEXT, this.now());
        return;
      }
      const open = this.openCards(m.turn);
      if (open.length === 1) {
        const card = open[0];
        this.endedPrompts.add(key(m.turn, card.it.remote.prompt));
        this.endCard(card, 'ended', ENDED_TEXT, this.now());
      } else if (open.length > 1) console.error(`Postbox’s daemon couldn’t record a prompt’s end in turn ${m.turn}: ${m.message}`);
    }
    // no-prompt (an answer that came too late) and no-tool (a reply to one already settled) change nothing: the
    // prompt-expired or the turn’s end that follows says the rest.
  }

  /**
   * @param {{ threadId: string, it: any }} card @param {string} status @param {string} message @param {number} at
   * @param {Record<string, unknown>} [extra]  more for the card, such as noAnswer
   */
  endCard(card, status, message, at, extra = {}) {
    const rt = this.rt;
    if (rt.permissionWaits.has(card.it.id)) rt.settlePermission(card.it.id, status, message, {}, { endedAt: at, ...extra });
    else {
      rt.patchItem(card.threadId, card.it.id, { status, answeredAt: this.now(), endedAt: at, ...extra });
      const se = rt.s.sessions[card.it.sessionId];
      if (se?.needs?.itemId === card.it.id) rt.updateSession(se.id, { needs: null, state: rt.turns.has(se.id) ? 'tool' : 'idle' });
    }
  }

  /** The card for a host prompt, in its session’s conversation. @param {string} turn @param {string} id */
  cardOf(turn, id) {
    const se = this.sessionOfTurn(turn);
    if (!se) return null;
    for (const threadId of this.rt.conversationThreads(se.threadId)) {
      const it = this.rt.store.items(threadId).find((/** @type {any} */ i) => i.kind === 'permission' && i.remote?.turn === turn && i.remote?.prompt === id);
      if (it) return { threadId, it };
    }
    return null;
  }

  /** @param {string} turn */
  openCards(turn) {
    const se = this.sessionOfTurn(turn);
    if (!se) return [];
    return this.rt.conversationThreads(se.threadId).flatMap((/** @type {string} */ threadId) =>
      this.rt.store
        .items(threadId)
        .filter((/** @type {any} */ i) => i.kind === 'permission' && i.status === 'open' && i.remote?.turn === turn)
        .map((/** @type {any} */ it) => ({ threadId, it })),
    );
  }

  /** The session a host turn is (or was last) of. @param {string} turn */
  sessionOfTurn(turn) {
    const live = this.byTurn.get(turn);
    if (live) return this.rt.s.sessions[live.sessionId] ?? null;
    const id = this.restoring.get(turn);
    if (id) return this.rt.s.sessions[id] ?? null;
    return Object.values(this.rt.s.sessions).find((se) => se.remoteTurn?.turn === turn) ?? null;
  }

  /** @param {string} hostId */
  linkOf(hostId) {
    return this.needed.get(hostId)?.link ?? this.hosts?.link(hostId);
  }

  // ── Ending ──────────────────────────────────────────────────────────────────────────

  /**
   * The runtime’s turn ended (endTurn): how it ended on the host decides its state, and the error the person sees.
   * Returns the error endTurn shows, which for Sign-in needed and Interrupted says so, with err.remote for the page.
   * @param {any} turn @param {any} err
   */
  ended(turn, err) {
    const live = /** @type {Live | undefined} */ (turn.remote);
    if (!live) return err;
    this.forget(live);
    const rt = this.rt;
    const se = rt.s.sessions[turn.sessionId];
    const host = rt.s.hosts?.[live.hostId];
    const name = host?.name ?? 'the host';
    if (live.current) this.offsetAt(live, live.current, live.offset, true);
    // Postbox is shutting down: the turn goes on on the host, and is attached again after the restart.
    if (rt.closing || !se?.remoteTurn || se.remoteTurn.rtTurn !== turn.id) return err;
    // Its cards nobody waits on (shown before a restart, not sent again) can’t be answered now.
    for (const t of live.hostTurns)
      for (const card of this.openCards(t)) if (!rt.permissionWaits.has(card.it.id)) this.endCard(card, 'expired', '', this.now());
    if (live.hung) return err;
    // No `ended` came for it, and it may be on the host: its runner may still be there, so it’s asked to stop there,
    // and that’s confirmed. One whose start never went (its preparation failed first) has nothing there to stop. A
    // sign-in error is a line from the host, so that turn’s start went.
    const unended = Boolean(live.current && live.exit === undefined && mayBeOnHost(live));
    if (live.signIn) {
      this.updateRemote(se.id, { state: 'signin', at: this.now(), resume: { why: 'signin', at: this.now() } });
      if (unended) this.askStop(se.id, live.hostId, /** @type {string} */ (live.current), { unconfirmed: unconfirmed(live) });
      this.checkedAt.delete(se.id);
      return remoteError(`Sign-in needed on ${name}. Sign in there, then resume @${se.handle}.`, { state: 'signin', hostId: live.hostId });
    }
    if (live.exit === null) {
      this.updateRemote(se.id, { state: 'interrupted', at: this.now(), resume: { why: 'interrupted', at: this.now() } });
      this.whenBack(live.hostId);
      return remoteError(`Interrupted on ${name}: the agent’s process there ended without finishing its turn.`, { state: 'interrupted', hostId: live.hostId });
    }
    if (err && live.started && live.exit === undefined && !live.link?.connected) {
      // The link gave up with the turn still on the host, as far as Postbox knows: it’s attached again once the host is back.
      this.updateRemote(se.id, { state: 'lost', at: this.now() });
      this.restoring.set(se.remoteTurn.turn, se.id);
      this.needHost(live.hostId);
      return err;
    }
    const asked = Boolean(
      err && unended && this.askStop(se.id, live.hostId, /** @type {string} */ (live.current), { state: true, unconfirmed: unconfirmed(live) }),
    );
    this.updateRemote(se.id, { ...(asked ? {} : { state: 'done', at: this.now() }), resume: null, ...(err ? {} : { autoResumes: 0 }) });
    return err;
  }

  /**
   * Stop on a remote turn: always a plain stop, through the daemon (the adapter’s stopTurn). A hung one says why.
   * @param {any} turn @param {{ by?: string, why?: string }} o
   */
  stopped(turn, { by, why } = {}) {
    const live = /** @type {Live | undefined} */ (turn.remote);
    if (!live) return;
    const rt = this.rt;
    const se = rt.s.sessions[turn.sessionId];
    // The adapter’s child sends the stop; Postbox keeps asking until the daemon confirms it (askStop). Asked before
    // the turn is forgotten, so the host stays needed and heard throughout. One whose start never reached a connected
    // link (it was down, or a file stdin hadn’t ended) can’t be on the host: its child ends here and sends nothing,
    // so there’s nothing to confirm, and it’s done at once.
    const asked = Boolean(
      se &&
        by !== 'shutdown' &&
        live.current &&
        live.exit === undefined &&
        mayBeOnHost(live) &&
        this.askStop(se.id, live.hostId, live.current, { send: false, unconfirmed: unconfirmed(live) }),
    );
    // Its process ends through the adapter (its child hears `ended`), but the turn is over here: what comes for it now
    // is refused, as a stopped turn’s calls are on the laptop (#126).
    this.forget(live);
    if (live.current) this.offsetAt(live, live.current, live.offset, true);
    if (!se) return;
    if (by === 'hung' && why) {
      // On the reply it stopped, or its last part when nothing was still streaming.
      const own = rt.store.items(turn.threadId).filter((/** @type {any} */ it) => it.turnId === turn.id && it.kind === 'agent');
      const stoppedHere = own.filter((/** @type {any} */ it) => it.status === 'stopped');
      for (const it of stoppedHere.length ? stoppedHere : own.slice(-1)) rt.patchItem(turn.threadId, it.id, { note: why });
      this.updateRemote(se.id, { state: 'hung', at: this.now(), message: why, resume: null });
      rt.tellAgent(se.id, `Postbox stopped your last turn on ${rt.s.hosts?.[live.hostId]?.name ?? 'the host'}: ${why.replace(/^Stopped: /, '')}.`);
      rt.notify('blocking', se, `@${se.handle} was stopped`, why, turn.threadId);
    } else if (by !== 'shutdown' && se.remoteTurn && ON_HOST.has(se.remoteTurn.state))
      this.updateRemote(se.id, { state: asked && this.stopping.has(se.remoteTurn.turn) ? 'stopping' : 'done', at: this.now(), resume: null });
  }

  /** @param {Live} live */
  forget(live) {
    if (this.live.get(live.sessionId) === live) this.live.delete(live.sessionId);
    for (const t of live.hostTurns) if (this.byTurn.get(t) === live) this.byTurn.delete(t);
    this.dirty.delete(live.sessionId);
    this.releaseHost(live.hostId);
  }

  // ── Hung, and the waits for a host ─────────────────────────────────────────────────

  /** The periodic look: stalls, and sign-in waits whose check is due. */
  tick() {
    this.checkStalls();
    for (const se of Object.values(this.rt.s.sessions))
      if (se.remoteTurn?.state === 'signin' && se.remoteTurn.resume && this.now() - (this.checkedAt.get(se.id) ?? 0) >= SIGN_IN_RECHECK_MS)
        void this.trySignInResume(se.id);
  }

  /** Stops each running remote turn that has been quiet for its host’s stallTimeout with nothing open. */
  checkStalls() {
    const now = this.now();
    for (const live of [...this.live.values()]) {
      if (live.rt.closed || live.hung || !live.current || !live.link?.connected) continue;
      const host = this.rt.s.hosts?.[live.hostId];
      const stall = Number(host?.settings?.stallTimeout ?? defaultHostSettings().stallTimeout);
      if (now - live.lastEvent < stall) continue;
      // Waiting on you isn’t hung, and neither is an open tool call for an adapter that prints nothing while one runs.
      if ([...this.rt.permissionWaits.values()].some((w) => w.sessionId === live.sessionId)) continue;
      if (live.work === 'open-tool-call' && live.rt.steps.some((/** @type {any} */ s) => s.state === 'running')) continue;
      const text = `Stopped: no output for ${Math.round(stall / 60_000)} min (the last at ${clock(live.lastEvent)})`;
      live.hung = { at: live.lastEvent, text };
      this.rt.stop(live.sessionId, { by: 'hung', why: text });
    }
  }

  /** @param {string} hostId */
  async signInCheck(hostId) {
    try {
      return (await this.hosts?.signInCheck(hostId)) ?? null;
    } catch {
      return { ok: false, code: null, at: this.now() };
    }
  }

  /** @param {string} hostId @param {any} status */
  hostStatus(hostId, status) {
    if (!isBack(status)) return;
    for (const se of Object.values(this.rt.s.sessions)) {
      const r = se.remoteTurn;
      if (r?.hostId !== hostId || this.live.has(se.id)) continue;
      if (ON_HOST.has(r.state) && this.restoring.has(r.turn)) void this.reattach(se.id);
      else if (r.state === 'interrupted' && r.resume) this.autoResume(se.id);
      else if (r.state === 'signin' && r.resume) void this.trySignInResume(se.id);
    }
  }

  /** After Interrupted: resume now if the host is up, else when it’s back (hostStatus). @param {string} hostId */
  whenBack(hostId) {
    if (!isBack(this.hosts?.status(hostId))) return;
    queueMicrotask(() => this.hostStatus(hostId, { state: 'connected' }));
  }

  /** After Sign-in needed: resume only once the host’s check passes; with no check, the person resumes. @param {string} sessionId */
  async trySignInResume(sessionId) {
    const se = this.rt.s.sessions[sessionId];
    if (se?.remoteTurn?.state !== 'signin' || !se.remoteTurn.resume) return;
    this.checkedAt.set(sessionId, this.now());
    const check = await this.signInCheck(se.remoteTurn.hostId);
    if (check?.ok === true) this.autoResume(sessionId);
  }

  /** @param {string} sessionId */
  autoResume(sessionId) {
    const rt = this.rt;
    const se = rt.s.sessions[sessionId];
    const r = se?.remoteTurn;
    if (!r?.resume || se.archived || se.deleting || rt.turns.has(sessionId) || rt.exiting.has(sessionId) || rt.closing) return;
    // Only on the host it stopped on: an agent moved since waits for the person.
    if (this.hostOf(rt.personaFor(se)) !== r.hostId) return;
    // An interruption that keeps coming back waits for the person after a few resumes.
    if (r.resume.why === 'interrupted' && (r.autoResumes ?? 0) >= AUTO_RESUMES) return;
    this.updateRemote(sessionId, { resume: { ...r.resume, auto: true }, autoResumes: (r.autoResumes ?? 0) + 1 });
    rt.deliver(sessionId, { kind: 'notice', text: 'Postbox resumed your turn on its own. Carry on where you left off.' });
  }

  /** The person’s Resume, after Sign-in needed or Interrupted. @param {string} sessionId */
  resume(sessionId) {
    const rt = this.rt;
    const se = rt.session(sessionId);
    const r = se.remoteTurn;
    if (!r?.resume) return { ok: false, message: `@${se.handle} has no stopped turn on a host to resume.` };
    if (rt.turns.has(sessionId)) return { ok: false, message: `@${se.handle} is already at work.` };
    this.updateRemote(sessionId, { resume: { ...r.resume, auto: false }, autoResumes: 0 });
    rt.deliver(sessionId, { kind: 'notice', text: 'The person asked you to resume. Carry on where you left off.' });
    return { ok: true };
  }

  // ── After a restart ────────────────────────────────────────────────────────────────

  /**
   * At startup: each session whose turn was on a host is attached again once the host’s welcome lists it, and one
   * that waits to resume waits again.
   */
  restore() {
    for (const se of Object.values(this.rt.s.sessions)) {
      const r = se.remoteTurn;
      if (!r) continue;
      // Stops asked before the restart and not confirmed: asked again. A host removed since can’t be asked.
      for (const x of r.stopping ?? []) {
        if (this.rt.s.hosts?.[x.hostId]) this.askStop(se.id, x.hostId, x.turn, { unconfirmed: x.unconfirmed === true });
        else this.dropStop(se.id, x.turn);
      }
      if (r.state === 'stopping' && !this.stopping.has(r.turn)) this.updateRemote(se.id, { state: 'done', at: this.now() });
      if (ON_HOST.has(r.state)) {
        if (!this.hosts || !this.rt.s.hosts?.[r.hostId]) {
          this.interrupted(se.id, 'Postbox can’t reach that host any more');
          continue;
        }
        this.restoring.set(r.turn, se.id);
        this.needHost(r.hostId);
        void this.reattach(se.id);
      } else if (r.state === 'interrupted' && r.resume) this.whenBack(r.hostId);
    }
  }

  /** Cards of a turn still on a host aren’t stale after a restart: the daemon sends their prompts again. @param {any} it */
  keepsCard(it) {
    const se = it.remote?.turn ? this.sessionOfTurn(it.remote.turn) : null;
    return Boolean(se && se.remoteTurn?.turn === it.remote.turn && ON_HOST.has(se.remoteTurn.state) && this.hosts);
  }

  /** @param {string} sessionId */
  async reattach(sessionId) {
    const rt = this.rt;
    const se = rt.s.sessions[sessionId];
    const r = se?.remoteTurn;
    if (!r || !this.restoring.has(r.turn) || this.live.has(sessionId) || rt.turns.has(sessionId)) return;
    let welcome;
    try {
      welcome = await this.hosts?.ensureWelcome(r.hostId);
    } catch {
      return; // not now: hostStatus tries again when the host is back
    }
    const now = rt.s.sessions[sessionId];
    if (!now || now.remoteTurn?.turn !== r.turn || !this.restoring.has(r.turn) || rt.turns.has(sessionId)) return;
    const listed = (welcome?.turns ?? []).find((/** @type {any} */ t) => t.turn === r.turn);
    // An agent moved off the host since can’t be attached there: its turn is left to end on its own.
    const moved = this.hostOf(rt.personaFor(now)) !== r.hostId;
    if (!listed || moved) {
      this.restoring.delete(r.turn);
      this.early.delete(r.turn);
      this.releaseHost(r.hostId);
      this.interrupted(sessionId, moved ? `@${now.handle} no longer runs there` : 'the host has no record of it');
      return;
    }
    // Running, ended or interrupted, it’s replayed from the start, so the reply is whole: what came before is replaced.
    for (const threadId of rt.conversationThreads(now.threadId))
      for (const it of rt.store.items(threadId))
        if (it.kind === 'agent' && it.turnId && it.turnId === r.rtTurn && it.status !== 'replaced')
          rt.patchItem(threadId, it.id, { status: 'replaced', text: '' });
    rt.updateSession(sessionId, { state: 'think', currentStep: `Reconnecting to ${rt.s.hosts?.[r.hostId]?.name ?? 'the host'}` });
    rt.deliver(sessionId, { kind: 'notice', text: '', attach: r.turn }, { threadId: r.threadId ?? null });
  }

  /**
   * Postbox gives up on a session’s turn on its host when nothing here is running it to Stop: one waiting to be
   * attached again (after a restart, or after its link gave up), and a resume waiting for the host. Archive, delete
   * and removing the host call it, after Stop, so nothing attaches or resumes for a conversation put away or a host
   * Postbox no longer knows. The host turn is asked to stop (the daemon stops it as a whole), now if the host is
   * connected, else at its next welcome; it’s in state `stopping`, not `done`, until the daemon confirms it (askStop).
   * Its cards can’t be answered any more. Returns whether there was a turn on the host to give up on.
   * @param {string} sessionId
   */
  cancel(sessionId) {
    const se = this.rt.s.sessions[sessionId];
    const r = se?.remoteTurn;
    if (!r || this.live.has(sessionId)) return false;
    const pending = this.restoring.get(r.turn) === sessionId;
    if (pending) {
      this.restoring.delete(r.turn);
      this.early.delete(r.turn);
    }
    const onHost = pending || ON_HOST.has(r.state);
    if (!onHost && !r.resume) return false;
    if (onHost) {
      for (const card of this.openCards(r.turn)) {
        this.endedPrompts.add(key(r.turn, card.it.remote.prompt));
        this.endCard(card, 'expired', '', this.now());
      }
    }
    const asked = onHost && this.askStop(sessionId, r.hostId, r.turn, { state: true });
    this.updateRemote(sessionId, { ...(asked ? {} : { state: 'done', at: this.now() }), resume: null });
    this.checkedAt.delete(sessionId);
    if (pending) this.releaseHost(r.hostId);
    return onHost;
  }

  // ── Stops the daemon confirms ──────────────────────────────────────────────────────

  /**
   * Asks a host to stop one of its turns, and keeps asking, at each welcome, until the daemon says it’s over (its
   * `ended`, a no-turn answer, or a welcome that doesn’t list it running): until then it may still run there. It’s
   * kept on the session (remoteTurn.stopping), so a restart asks again, and the host is needed, so its link
   * reconnects. send: false when the adapter’s child sends this stop itself; state: the session’s turn is in state
   * `stopping` until then; unconfirmed: as on Stop, for a stop asked first (restore passes the saved one).
   * Returns false without a host manager, when nothing can be asked.
   * @param {string} sessionId @param {string} hostId @param {string} turn
   * @param {{ send?: boolean, state?: boolean, unconfirmed?: boolean }} [o]
   */
  askStop(sessionId, hostId, turn, { send: now = true, state = false, unconfirmed = false } = {}) {
    if (!this.hosts) return false;
    let s = this.stopping.get(turn);
    if (!s) {
      s = { sessionId, hostId, waiters: [], unconfirmed };
      this.stopping.set(turn, s);
      this.needHost(hostId);
    }
    const r = this.rt.s.sessions[sessionId]?.remoteTurn;
    if (r) {
      const stopping = r.stopping ?? [];
      this.updateRemote(sessionId, {
        ...(stopping.some((/** @type {any} */ x) => x.turn === turn) ? {} : { stopping: [...stopping, stopEntry({ turn, hostId, at: this.now() }, s)] }),
        ...(state && r.turn === turn ? { state: 'stopping', at: this.now() } : {}),
      });
    }
    if (now) this.sendStop(turn);
    return true;
  }

  /** Sends a stop Postbox is waiting on, if the host is connected now. @param {string} turn */
  sendStop(turn) {
    const s = this.stopping.get(turn);
    if (!s) return false;
    /** @type {any} */
    let link = null;
    try {
      link = this.linkOf(s.hostId);
    } catch {}
    return Boolean(link?.connected) && send(link, 'stop', { turn });
  }

  /** The daemon says a turn Postbox asked to stop is over, or isn’t there. @param {string} turn */
  stopConfirmed(turn) {
    const s = this.stopping.get(turn);
    if (!s) return;
    this.stopping.delete(turn);
    this.dropStop(s.sessionId, turn);
    this.releaseHost(s.hostId);
    for (const w of s.waiters) w();
  }

  /** A stop’s flags changed: its entry in remoteTurn.stopping says so, for a restart. @param {string} sessionId @param {string} turn */
  saveStop(sessionId, turn) {
    const s = this.stopping.get(turn);
    const r = this.rt.s.sessions[sessionId]?.remoteTurn;
    if (!s || !r?.stopping?.some((/** @type {any} */ x) => x.turn === turn)) return;
    this.updateRemote(sessionId, {
      stopping: r.stopping.map((/** @type {any} */ x) => (x.turn === turn ? stopEntry({ turn: x.turn, hostId: x.hostId, at: x.at }, s) : x)),
    });
  }

  /** @param {string} sessionId @param {string} turn */
  dropStop(sessionId, turn) {
    const r = this.rt.s.sessions[sessionId]?.remoteTurn;
    if (!r) return;
    this.updateRemote(sessionId, {
      stopping: (r.stopping ?? []).filter((/** @type {any} */ x) => x.turn !== turn),
      ...(r.turn === turn && r.state === 'stopping' ? { state: 'done', at: this.now() } : {}),
    });
  }

  /**
   * For removing a host: waits up to waitMs for the daemon to confirm every stop Postbox asked of it, asking again now
   * if the host is connected, or connecting first, so the stops go at its welcome. Returns the host turns still not
   * confirmed, with noToken when this Postbox has no token for the host (not-installed): nothing can reach it, so
   * nothing waits, and the stops stay, since a missing token says nothing about whether those turns still run.
   * @param {string} hostId @param {number} waitMs @returns {Promise<{ left: string[], noToken: boolean }>}
   */
  async confirmStops(hostId, waitMs) {
    const left = () => [...this.stopping].filter(([, s]) => s.hostId === hostId).map(([t]) => t);
    if (!left().length || !this.hosts) return { left: left(), noToken: false };
    /** @type {any} */
    let link = null;
    try {
      link = this.hosts.link(hostId);
    } catch (e) {
      if (e?.code === 'not-installed') return { left: left(), noToken: true };
    }
    this.listen(hostId);
    const all = Promise.all(left().map((t) => new Promise((r) => this.stopping.get(t)?.waiters.push(() => r(undefined)))));
    // Connected, each is asked again, as at a welcome (a stop the adapter’s child sent may have been lost with it).
    if (link?.connected) for (const t of left()) this.sendStop(t);
    else if (link) this.hosts.ensureWelcome(hostId).catch(() => {});
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    const late = new Promise((r) => {
      timer = setTimeout(r, waitMs);
    });
    await Promise.race([all, late]);
    clearTimeout(timer);
    return { left: left(), noToken: false };
  }

  /**
   * Whether a host has turns that run there, or may: running here, being attached again, waiting for its stop to be
   * confirmed, or waiting to resume there (Interrupted, Sign-in needed) for an agent still placed there. Renaming it
   * is refused meanwhile.
   * @param {string} hostId
   */
  busyOn(hostId) {
    if ([...this.live.values()].some((l) => l.hostId === hostId)) return true;
    if ([...this.stopping.values()].some((s) => s.hostId === hostId)) return true;
    return Object.values(this.rt.s.sessions).some((se) => {
      const r = se.remoteTurn;
      if (r?.hostId !== hostId) return false;
      if (ON_HOST.has(r.state) || r.state === 'stopping' || this.restoring.has(r.turn)) return true;
      // A resume goes only to the host it stopped on, for an agent still placed there (autoResume).
      return Boolean(r.resume) && this.hostOf(this.rt.personaFor(se)) === hostId;
    });
  }

  /** A turn that was on a host and is gone: Interrupted, and resumed once the host is back. @param {string} sessionId @param {string} why */
  interrupted(sessionId, why) {
    const rt = this.rt;
    const se = rt.s.sessions[sessionId];
    if (!se?.remoteTurn) return;
    const name = rt.s.hosts?.[se.remoteTurn.hostId]?.name ?? 'its host';
    const message = `Interrupted on ${name}: ${why}.`;
    const it = rt.addItem(se.threadId, {
      kind: 'agent',
      sessionId,
      personaId: se.personaId,
      handle: se.handle,
      turnId: se.remoteTurn.rtTurn ?? null,
      text: '',
      status: 'failed',
      error: message,
      remote: { state: 'interrupted', hostId: se.remoteTurn.hostId },
    });
    this.updateRemote(sessionId, { state: 'interrupted', at: this.now(), resume: { why: 'interrupted', at: this.now() } });
    rt.updateSession(sessionId, {
      state: 'failed',
      needs: { kind: 'failed', itemId: it.id, text: message },
      currentStep: 'Interrupted',
      finishedAt: this.now(),
    });
    this.whenBack(se.remoteTurn.hostId);
  }

  /** @param {string} sessionId @param {Record<string, any>} patch */
  updateRemote(sessionId, patch) {
    const se = this.rt.s.sessions[sessionId];
    if (se?.remoteTurn) this.rt.updateSession(sessionId, { remoteTurn: { ...se.remoteTurn, ...patch } });
  }
}

/** The tools that return at once on the host (TOOL_ROUTES’ queue). */
const TOOL_QUEUED = new Set(Object.keys(TOOL_ROUTES).filter((k) => TOOL_ROUTES[/** @type {keyof typeof TOOL_ROUTES} */ (k)] === 'queue'));

/** The line a resumed turn starts with (the design, “Resuming says why”). @param {string} why @param {string} host */
export function whyLine(why, host) {
  return why === 'signin'
    ? `[Postbox] Your last turn on ${host} stopped before it finished, because the sign-in on that host had run out. It wasn’t this message that stopped it.`
    : `[Postbox] Your last turn on ${host} was interrupted before it finished: its process on the host ended without a result, as when the host restarts. It wasn’t this message that stopped it.`;
}

/**
 * A stop’s entry in remoteTurn.stopping, with its flag only when it’s set.
 * @param {{ turn: string, hostId: string, at: number }} base @param {{ unconfirmed: boolean }} s
 */
function stopEntry(base, s) {
  return { ...base, ...(s.unconfirmed ? { unconfirmed: true } : {}) };
}

/**
 * Whether a live turn’s current host turn may be on the host: its start was written to a connected link, the daemon
 * confirmed it, or it was there already (attached).
 * @param {Live} live
 */
function mayBeOnHost(live) {
  return live.startSent || live.started || live.attach;
}

/** Whether a live turn’s current start was written but never confirmed. @param {Live} live */
function unconfirmed(live) {
  return live.startSent && !live.started;
}

/** @param {string} message @param {{ state: string, hostId: string }} remote */
function remoteError(message, remote) {
  return Object.assign(new Error(message), { userMessage: message, remote });
}

function abortError() {
  return Object.assign(new Error('Stopped by you.'), { name: 'AbortError' });
}

/** Whether a host status says it’s connected. @param {any} st */
function isBack(st) {
  return st?.state === 'connected';
}

/**
 * Sends one postbox-to-daemon message, built (and checked) here; false if it wasn’t valid or there’s no session.
 * @param {any} link @param {string} type @param {Record<string, unknown>} body
 */
function send(link, type, body) {
  let msg;
  try {
    msg = protocolMessage('postbox-to-daemon', type, body);
  } catch (e) {
    console.error(`Postbox couldn’t send ${type} to the host: ${e.message}`);
    return false;
  }
  return link?.send?.(msg) === true;
}

/** Whether a stdout line is an event with all these fields. @param {string} text @param {Record<string, unknown>} fields */
function matches(text, fields) {
  // Most lines aren’t: a quick look at the text first, so a busy stream isn’t parsed twice.
  if (!Object.values(fields).every((v) => typeof v !== 'string' || text.includes(v))) return false;
  try {
    const e = JSON.parse(text);
    return Object.entries(fields).every(([k, v]) => e?.[k] === v);
  } catch {
    return false;
  }
}

/**
 * A snapshot within one message’s limit: the oldest items’ full text goes first (their lines stay, so paging still
 * counts them), then their lines.
 * @param {{ id: string, items: { id: string, line: string, text: string, blockId?: string }[] }[]} threads
 */
function fit(threads) {
  const limit = REMOTE_LIMITS.lineBytes - 64 * 1024;
  if (encodedBytes({ threads }) <= limit) return threads;
  for (const field of /** @type {const} */ (['text', 'line'])) {
    const all = threads.flatMap((t) => t.items);
    let size = encodedBytes({ threads });
    for (const it of all) {
      if (size <= limit) return threads;
      size -= Buffer.byteLength(JSON.stringify(it[field]), 'utf8') - 2;
      it[field] = '';
    }
  }
  return threads;
}
