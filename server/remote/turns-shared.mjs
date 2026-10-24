// What the modules of a remote turn’s life on the laptop share (#120, server/remote/turns.mjs): its timings and
// limits, the shapes of a live turn and of a stop Postbox waits on, and the small helpers each of them uses.

import { message as protocolMessage, TOOL_ROUTES } from '../../shared/remote-protocol.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */

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
export const KEPT_REPLIES = 200;
export const KEPT_REPLY_CHARS = 2000;
/** Messages held for a turn being attached after a restart, at most. */
export const EARLY_MESSAGES = 500;

/** What the laptop says to a call from a stopped turn (server/mcp.mjs), word for word. */
export const STOPPED_TEXT = 'This call came from an agent turn that was stopped or has ended, so Postbox didn’t run it.';

/** What a card says when the host ended its prompt but couldn’t record that. */
export const ENDED_TEXT = 'The host ended this prompt but couldn’t record it, so it can’t be answered any more.';
/** States in which a session’s remote turn is still on the host as far as Postbox knows. */
export const ON_HOST = new Set(['running', 'waiting', 'lost']);
/** @param {string} turn @param {string} id */
export const key = (turn, id) => `${turn}\n${id}`;
/** @param {number} at */
export const clock = (at) => new Date(at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

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
 * it may have come before the start reached the daemon (server/remote/turns.mjs, the header).
 * @typedef {{ sessionId: string, hostId: string, waiters: (() => void)[], unconfirmed: boolean }} Stop
 */

/** The tools that return at once on the host (TOOL_ROUTES’ queue). */
export const TOOL_QUEUED = new Set(Object.keys(TOOL_ROUTES).filter((k) => TOOL_ROUTES[/** @type {keyof typeof TOOL_ROUTES} */ (k)] === 'queue'));

/** The line a resumed turn starts with (the design, “Resuming says why”). @param {string} why @param {string} host */
export function whyLine(why, host) {
  return why === 'signin'
    ? `[Postbox] Your last turn on ${host} stopped before it finished, because the sign-in on that host had run out. It wasn’t this message that stopped it.`
    : `[Postbox] Your last turn on ${host} was interrupted before it finished: its process on the host ended without a result, as when the host restarts. It wasn’t this message that stopped it.`;
}

/** The host a persona runs on, or null for this computer. @param {any} persona */
export function hostOf(persona) {
  const id = persona?.remote?.hostId;
  return typeof id === 'string' && id ? id : null;
}

/** @param {RemoteTurns} rts @param {string} sessionId @param {Record<string, any>} patch */
export function updateRemote(rts, sessionId, patch) {
  const se = rts.rt.s.sessions[sessionId];
  if (se?.remoteTurn) rts.rt.updateSession(sessionId, { remoteTurn: { ...se.remoteTurn, ...patch } });
}

/** The session a host turn is (or was last) of. @param {RemoteTurns} rts @param {string} turn */
export function sessionOfTurn(rts, turn) {
  const live = rts.byTurn.get(turn);
  if (live) return rts.rt.s.sessions[live.sessionId] ?? null;
  const id = rts.restoring.get(turn);
  if (id) return rts.rt.s.sessions[id] ?? null;
  return Object.values(rts.rt.s.sessions).find((se) => se.remoteTurn?.turn === turn) ?? null;
}

/**
 * Whether a live turn’s current host turn may be on the host: its start was written to a connected link, the daemon
 * confirmed it, or it was there already (attached).
 * @param {Live} live
 */
export function mayBeOnHost(live) {
  return live.startSent || live.started || live.attach;
}

/** Whether a live turn’s current start was written but never confirmed. @param {Live} live */
export function unconfirmed(live) {
  return live.startSent && !live.started;
}

/** @param {string} message @param {{ state: string, hostId: string }} remote */
export function remoteError(message, remote) {
  return Object.assign(new Error(message), { userMessage: message, remote });
}

export function abortError() {
  return Object.assign(new Error('Stopped by you.'), { name: 'AbortError' });
}

/** Whether a host status says it’s connected. @param {any} st */
export function isBack(st) {
  return st?.state === 'connected';
}

/**
 * Sends one postbox-to-daemon message, built (and checked) here; false if it wasn’t valid or there’s no session.
 * @param {any} link @param {string} type @param {Record<string, unknown>} body
 */
export function send(link, type, body) {
  let msg;
  try {
    msg = protocolMessage('postbox-to-daemon', type, body);
  } catch (e) {
    console.error(`Postbox couldn’t send ${type} to the host: ${e.message}`);
    return false;
  }
  return link?.send?.(msg) === true;
}
