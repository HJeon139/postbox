// Starting a remote turn (#120, server/remote/turns.mjs, the header): deliver makes the turn remote at once (begin),
// and before its adapter starts, the host has its welcome, the host turn has its ID, kept on the session as
// se.remoteTurn so it survives a restart, the host has the conversation’s snapshot, and the message’s attachments
// are read to go with the start (prepare).

import { randomUUID } from 'node:crypto';
import { defaultHostSettings } from '../../shared/remote-settings.mjs';
import { offersBring } from '../bring.mjs';
import { asksByPrompt } from '../permission-prompt.mjs';
import { noteScheduledTurn } from '../scheduled-wakes.mjs';
import { wokeOf } from '../turn-marks.mjs';
import { carryAttachments } from './attachments.mjs';
import { listen, needHost, releaseHost } from './turns-need.mjs';
import { continueAs, keepOrigin } from './turns-origin.mjs';
import { signInCheck } from './turns-resume.mjs';
import { abortError, OFFSET_SAVE_MS, updateRemote, whyLine } from './turns-shared.mjs';
import { sendSnapshot } from './turns-snapshot.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */
/** @typedef {import('./turns-shared.mjs').Live} Live */

/**
 * Called by deliver, synchronously, for a persona on a host: the turn is remote from now on, so Stop treats it as
 * one, and the host is needed. prepare() does the rest before the adapter starts.
 * @param {RemoteTurns} rts @param {any} turn @param {string} hostId @param {any} adapter
 */
export function begin(rts, turn, hostId, adapter) {
  // A turn that continues one on the host is that turn from here on (turns-origin.mjs).
  continueAs(turn);
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
    lastEvent: rts.now(),
    signIn: false,
    exit: undefined,
    hung: null,
    offset: 0,
    offsetSaved: 0,
    attach: false,
    started: false,
    startSent: false,
    origin: null,
  };
  turn.remote = live;
  rts.live.set(turn.sessionId, live);
  needHost(rts, hostId);
  return live;
}

/**
 * Everything a remote turn needs before its adapter starts: the message’s attachments, the host’s welcome, the turn’s
 * ID (persisted) and the snapshot. Fills ctx.remote, and returns the message to deliver, which starts with why the
 * last turn stopped when it’s a resume. message.attach (a host turn ID) attaches to that turn instead (after a restart).
 * @param {RemoteTurns} rts @param {any} turn @param {any} ctx @param {any} message
 */
export async function prepare(rts, turn, ctx, message) {
  const rt = rts.rt;
  const live = /** @type {Live} */ (turn.remote);
  const se = rt.s.sessions[turn.sessionId];
  const persona = ctx.persona;
  const host = rt.s.hosts?.[live.hostId];
  const { version, hosts } = startable(rts, se, persona, host);
  const attach = typeof message.attach === 'string' ? message.attach : null;
  // Read now, so a message over the limits is refused before anything is asked of the host (attachments.mjs).
  const attachments = attach ? [] : await carryAttachments(message, ctx.pathOf);
  // A host renamed while turns still run over its old link: nothing new starts there, and nothing falls back to it.
  let welcome;
  let link;
  try {
    welcome = await hosts.ensureWelcome(live.hostId);
    link = hosts.link(live.hostId);
  } catch (e) {
    throw renamedBusy(rts, e, live.hostId, se) ?? e;
  }
  if (ctx.signal.aborted) throw abortError();
  live.link = trackAcks(rts, live, listen(rts, live.hostId) ?? link);
  if (!attach) await warnSignIn(rts, turn, ctx, se, host);
  const project = rt.s.projects[rt.s.threads[se.threadId]?.projectId] ?? null;
  const folder = project?.hostFolders?.[live.hostId] ?? `${welcome.home === '/' ? '' : welcome.home}/postbox-work/${persona.handle}`;
  const prior = se.remoteTurn ?? null;
  const resume = !attach && prior?.resume ? prior.resume : null;
  // What it was asked, a large request written to Postbox’s store first, so the record allocate saves never names a
  // copy that isn’t there (turns-origin.mjs).
  live.origin = await keepOrigin(rt, turn, wokeOf(turn).woke);
  if (ctx.signal.aborted) throw abortError();
  /** @type {import('../adapters/adapter.mjs').RemoteContext} */
  const remote = {
    link: live.link,
    welcome,
    settings: { ...defaultHostSettings(), ...host.settings },
    folder,
    version,
    nextTurn: async () => allocate(rts, live, folder),
    // As server/mcp.mjs lists bring_to_conversation only for such a turn, so does the shim (shimArgs).
    bring: offersBring(rt, turn),
    // As server/mcp.mjs offers permission_prompt only to a backend that asks through it, so does the shim (shimArgs).
    asksByPrompt: asksByPrompt(rt, turn.sessionId),
    attachments,
  };
  if (attach) attachTo(rts, live, se, turn, attach, remote);
  else {
    remote.turn = allocate(rts, live, folder);
    if (resume?.why === 'interrupted') remote.resumeInterrupted = true;
  }
  ctx.remote = remote;
  if (!resume) return message;
  const line = whyLine(resume.why, host.name);
  return message.slash === true ? message : { ...message, context: [line, ...(message.context ?? [])] };
}

/**
 * Why a remote turn can’t start, thrown, before anything is asked of its host; else Postbox’s own version, which
 * names its code on the host, and the host manager.
 * @param {RemoteTurns} rts @param {any} se @param {any} persona @param {any} host
 */
function startable(rts, se, persona, host) {
  const adapter = rts.rt.adapters.get(persona.backend);
  if (!adapter?.capabilities?.remote)
    throw new Error(
      `@${se.handle}’s backend (${persona.backend}) can’t run on a remote host. Choose Claude Code, Kiro CLI or Codex, or run it on this computer.`,
    );
  if (!host) throw new Error(`@${se.handle}’s host was removed, so this turn couldn’t start. Choose another host for it, or this computer.`);
  if (!rts.hosts) throw new Error(`Postbox isn’t set up to reach remote hosts, so @${se.handle}’s turn on ${host.name} couldn’t start.`);
  const version = rts.rt.config.build?.version;
  if (typeof version !== 'string' || !version) throw new Error('Postbox doesn’t know its own version, so it can’t find its code on the host.');
  return { version, hosts: rts.hosts };
}

/**
 * A sign-in that’s run out shows before the turn, not at its first model request (the design, “Sign-in stays the
 * host’s”). It’s a warning: the check may be wrong, and the person decides.
 * @param {RemoteTurns} rts @param {any} turn @param {any} ctx @param {any} se @param {any} host
 */
async function warnSignIn(rts, turn, ctx, se, host) {
  const check = await signInCheck(rts, turn.remote.hostId);
  if (ctx.signal.aborted) throw abortError();
  if (check && !check.ok)
    rts.rt.notify(
      'blocking',
      se,
      `Sign-in on ${host.name} may have run out`,
      `The host’s sign-in check failed${check.code === null ? '' : ` (exit code ${check.code})`}, so @${se.handle}’s turn there may stop with “Sign-in needed”. Sign in on the host, then carry on.`,
      turn.threadId,
    );
}

/**
 * A turn attached again after a restart: it goes on as the host turn it was, and hears what came for it meanwhile.
 * @param {RemoteTurns} rts @param {Live} live @param {any} se @param {any} turn @param {string} attach @param {any} remote
 */
function attachTo(rts, live, se, turn, attach, remote) {
  live.attach = true;
  adopt(rts, live, attach);
  live.started = true;
  remote.attach = { turn: attach };
  if (rts.restoring.delete(attach)) releaseHost(rts, live.hostId);
  updateRemote(rts, se.id, { state: 'running', rtTurn: turn.id, at: rts.now() });
  for (const m of rts.early.get(attach) ?? []) rts.onHostMessage(live.hostId, m);
  rts.early.delete(attach);
}

/**
 * The refusal for a turn that would start on a renamed host’s old destination (the host manager’s host-renamed-busy),
 * or null for any other error.
 * @param {RemoteTurns} rts @param {any} e @param {string} hostId @param {any} se
 */
function renamedBusy(rts, e, hostId, se) {
  if (e?.code !== 'host-renamed-busy') return null;
  const name = rts.rt.s.hosts?.[hostId]?.name ?? 'Its host';
  const old = rts.hosts?.destinationOf?.(hostId);
  const message = `${name} was renamed while Postbox still had turns running on ${old ?? 'its old address'}, so @${se.handle}’s turn didn’t start: it would have run on the old machine. Try again once those turns end.`;
  return Object.assign(new Error(message), { userMessage: message, code: e.code });
}

/** A new host turn for a live turn: its ID, persisted on the session, and its snapshot. @param {RemoteTurns} rts @param {Live} live @param {string} folder */
function allocate(rts, live, folder) {
  const id = randomUUID();
  adopt(rts, live, id);
  const se = rts.rt.s.sessions[live.sessionId];
  const prior = se?.remoteTurn ?? {};
  rts.rt.updateSession(live.sessionId, {
    remoteTurn: {
      hostId: live.hostId,
      turn: id,
      offset: 0,
      rtTurn: live.rt.id,
      threadId: live.rt.threadId,
      folder,
      state: 'running',
      at: rts.now(),
      autoResumes: prior.resume?.auto ? (prior.autoResumes ?? 0) : 0,
      replies: prior.replies ?? [],
      stopping: prior.stopping ?? [],
      // What it was asked, so a turn that continues it ends as it would have (prepare, turns-origin.mjs).
      origin: live.origin,
    },
  });
  // A scheduled wake’s own turn, which a restart leaves to this host turn (rearmWakes).
  noteScheduledTurn(rts.rt, live.rt);
  sendSnapshot(rts, live, id);
  return id;
}

/** @param {RemoteTurns} rts @param {Live} live @param {string} id */
function adopt(rts, live, id) {
  live.hostTurns.add(id);
  live.current = id;
  live.started = false;
  live.startSent = false;
  live.exit = undefined;
  live.offset = 0;
  live.offsetSaved = 0;
  rts.byTurn.set(id, live);
}

/** The link as the adapter gets it: the host’s, with each ack it sends recorded as the turn’s offset. @param {RemoteTurns} rts @param {Live} live @param {any} link */
function trackAcks(rts, live, link) {
  return new Proxy(link, {
    get: (target, prop) => {
      if (prop === 'send')
        return (/** @type {any} */ msg) => {
          const ok = target.send(msg);
          if (ok && msg?.type === 'ack' && live.hostTurns.has(msg.turn)) offsetAt(rts, live, msg.turn, msg.upTo);
          // Written to a channel that had its welcome: it may be on the host from now on, confirmed or not.
          if (ok && msg?.type === 'start' && msg.turn === live.current) live.startSent = true;
          return ok;
        };
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** @param {RemoteTurns} rts @param {Live} live @param {string} turn @param {number} upTo @param {boolean} [now]  write it at once */
export function offsetAt(rts, live, turn, upTo, now = false) {
  if (turn !== live.current || upTo < live.offset) return;
  live.offset = upTo;
  if (!now && rts.now() - live.offsetSaved < OFFSET_SAVE_MS) return;
  live.offsetSaved = rts.now();
  const se = rts.rt.s.sessions[live.sessionId];
  if (se?.remoteTurn?.turn === turn) updateRemote(rts, se.id, { offset: upTo });
}
