// Starting a remote turn (#120, server/remote/turns.mjs, the header): deliver makes the turn remote at once (begin),
// and before its adapter starts, the host has its welcome, the host turn has its ID, kept on the session as
// se.remoteTurn so it survives a restart, the host has the conversation’s snapshot, and the message’s attachments
// are read to go with the start (prepare).

import { randomUUID } from 'node:crypto';
import { defaultHostSettings } from '../../shared/remote-settings.mjs';
import { offersBring } from '../bring.mjs';
import { hostRulesOf } from '../host-rules.mjs';
import { asksByPrompt } from '../permission-prompt.mjs';
import { backTo } from '../reply-back.mjs';
import { noteScheduledTurn, retryHostWake } from '../scheduled-wakes.mjs';
import { wokeOf } from '../turn-marks.mjs';
import { carryAttachments } from './attachments.mjs';
import { listen, needHost, releaseHost } from './turns-need.mjs';
import { continueAs, keepOrigin } from './turns-origin.mjs';
import { claimShown, endOrphanCards } from './turns-prompts.mjs';
import { replaying } from './turns-replay.mjs';
import { abortError, OFFSET_SAVE_MS, remoteOf, updateRemote, whyLine } from './turns-shared.mjs';
import { warnSignIn } from './turns-signin.mjs';
import { sendSnapshot } from './turns-snapshot.mjs';
import { askStop } from './turns-stops.mjs';

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
    backgroundTasks: caps?.backgroundTasks ?? null,
    background: null,
    resultSent: false,
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
    replay: null,
    ceilings: new Map(),
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
  // What the host says of the turn outside its stream, such as a relay it lost (turns-relay.mjs), shows as its step.
  live.step = (s) => ctx.activity(s);
  const se = rt.s.sessions[turn.sessionId];
  const persona = ctx.persona;
  const host = rt.s.hosts?.[live.hostId];
  const { version, hosts } = startable(rts, se, persona, host);
  const attach = typeof message.attach === 'string' ? message.attach : null;
  // Read now, so a message over the limits is refused before anything is asked of the host (attachments.mjs).
  const attachments = attach ? [] : await carryAttachments(message, ctx.pathOf);
  const { welcome, link } = await welcomeOf(rts, hosts, live, ctx, se);
  live.link = trackAcks(rts, live, listen(rts, live.hostId) ?? link);
  if (!attach) await warnSignIn(rts, turn, ctx, se, host);
  const project = rt.s.projects[rt.s.threads[se.threadId]?.projectId] ?? null;
  const folder = project?.hostFolders?.[live.hostId] ?? `${welcome.home === '/' ? '' : welcome.home}/postbox-work/${persona.handle}`;
  // As written: the resume ended wrote, maybe still held behind a commit, makes this turn a resume (#623).
  const prior = remoteOf(rts, turn.sessionId)?.remoteTurn ?? null;
  const resume = !attach && prior?.resume ? prior.resume : null;
  // What it was asked, a large request written to Postbox’s store first, so the record allocate saves never names a
  // copy that isn’t there (turns-origin.mjs).
  live.origin = await keepOrigin(rt, turn, wokeOf(turn).woke, turn.backTo ?? backTo(rt.delivery.takenBy(turn.sessionId, turn.id)));
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
    // What the person always allowed for this persona on this host, from a card (host-rules.mjs): its own, no other host’s.
    allow: hostRulesOf(rt, persona.id, live.hostId),
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
 * The host’s welcome and link for a turn’s start. A host renamed while turns still run over its old link: nothing new
 * starts there, and nothing falls back to it.
 * @param {RemoteTurns} rts @param {any} hosts @param {Live} live @param {any} ctx @param {any} se
 */
async function welcomeOf(rts, hosts, live, ctx, se) {
  let welcome;
  let link;
  try {
    // Stop ends a wait for an install of this version there at once (#464-b2b); the install goes on.
    welcome = await hosts.ensureWelcome(live.hostId, { signal: ctx.signal });
    link = hosts.link(live.hostId);
  } catch (e) {
    if (ctx.signal.aborted) throw abortError();
    throw renamedBusy(rts, e, live.hostId, se) ?? e;
  }
  if (ctx.signal.aborted) throw abortError();
  return { welcome, link };
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
 * A turn attached again after a restart: it goes on as the host turn it was, and hears what came for it meanwhile.
 * @param {RemoteTurns} rts @param {Live} live @param {any} se @param {any} turn @param {string} attach @param {any} remote
 */
function attachTo(rts, live, se, turn, attach, remote) {
  live.attach = true;
  adopt(rts, live, attach);
  live.started = true;
  // Read again from the start: the prompts that came meanwhile wait for the replay (turns-replay.mjs).
  replaying(live);
  remote.attach = { turn: attach };
  if (rts.restoring.delete(attach)) releaseHost(rts, live.hostId);
  rts.noteAttach(se.id);
  updateRemote(rts, se.id, { state: 'running', rtTurn: turn.id, at: rts.now() });
  // The wake it continues names it as its own now, so a second restart leaves the wake to it too (rearmWakes, #466).
  noteScheduledTurn(rts.rt, turn);
  // Before the prompts that came meanwhile: a card shown before the restart still holds its call.
  claimShown(rts, live, attach);
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

/**
 * A turn starts on another host, or on this computer, while the agent’s last one waits on its old host to be attached
 * (#1214): the agent moved, and the new turn came without the queue (Send now, a scheduled wake, #1135’s gap). The old
 * one is left as the attach leaves a moved agent’s (reattach): no longer waited for, its cards ended, and its host
 * asked to stop it, now or once it’s back (askStop).
 * @param {RemoteTurns} rts @param {string} sessionId @param {string | null} hostId  where the new turn runs, or null for here
 */
export function leaveMoved(rts, sessionId, hostId) {
  const r = remoteOf(rts, sessionId)?.remoteTurn; // as written (#623)
  if (!r?.turn || r.hostId === hostId) return;
  // A wake that turn was, waiting to be attached or resumed, retries where its agent runs now, as reattach’s give-up
  // does (#466).
  retryHostWake(rts.rt, sessionId);
  if (rts.restoring.get(r.turn) !== sessionId) return;
  rts.restoring.delete(r.turn);
  rts.noteAttach(sessionId);
  rts.early.delete(r.turn);
  endOrphanCards(rts, [r.turn]);
  // Asked before the restore’s hold on the host is let go, so its link isn’t dropped in between (#965). A turn here
  // doesn’t take the session’s remoteTurn, as a new host turn does, so the old one shows as stopping until its host
  // stops it: it may still run there meanwhile, and the agent reads as stopping, not running (#1442).
  askStop(rts, sessionId, r.hostId, r.turn, { state: !hostId });
  releaseHost(rts, r.hostId);
}

/** A new host turn for a live turn: its ID, persisted on the session, and its snapshot. @param {RemoteTurns} rts @param {Live} live @param {string} folder */
function allocate(rts, live, folder) {
  const id = randomUUID();
  adopt(rts, live, id);
  leaveMoved(rts, live.sessionId, live.hostId);
  // A turn that doesn’t continue the last one there ends the resume that carried a wake (#466). Not this turn’s own
  // second host turn (nextTurn, a fresh start after a missing session), whose wake is its own and still runs.
  if (!live.rt.origin && remoteOf(rts, live.sessionId)?.remoteTurn?.rtTurn !== live.rt.id) retryHostWake(rts.rt, live.sessionId);
  // Built from the session as written, so a resume’s count, a kept reply or a stop held behind a commit carries over (#623).
  rts.rt.sessions.update(live.sessionId, (se) => {
    const prior = se.remoteTurn ?? {};
    return {
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
    };
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
          // A read of out.jsonl, after the start or a reconnect: until it has caught up, lines may still be on their way.
          if (ok && msg?.type === 'read' && msg.log !== 'in' && msg.turn === live.current) replaying(live);
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
  // As written: allocate’s remoteTurn for this host turn may still be held behind a commit (#623).
  if (remoteOf(rts, live.sessionId)?.remoteTurn?.turn === turn) updateRemote(rts, live.sessionId, { offset: upTo });
}
