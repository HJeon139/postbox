// How a remote turn ends on the laptop (#120, server/remote/turns.mjs, the header): endTurn and Stop hand it here, and
// how it ended on the host decides its state (done, signin, interrupted, lost, hung or stopping) and what the person
// sees.

import { needHost, releaseHost } from './turns-need.mjs';
import { endCard, openCards } from './turns-prompts.mjs';
import { whenBack } from './turns-resume.mjs';
import { mayBeOnHost, ON_HOST, remoteError, unconfirmed, updateRemote } from './turns-shared.mjs';
import { offsetAt } from './turns-start.mjs';
import { askStop } from './turns-stops.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */
/** @typedef {import('./turns-shared.mjs').Live} Live */

/**
 * The runtime’s turn ended (endTurn): how it ended on the host decides its state, and the error the person sees.
 * Returns the error endTurn shows, which for Sign-in needed and Interrupted says so, with err.remote for the page.
 * @param {RemoteTurns} rts @param {any} turn @param {any} err
 */
export function ended(rts, turn, err) {
  const live = /** @type {Live | undefined} */ (turn.remote);
  if (!live) return err;
  forget(rts, live);
  const rt = rts.rt;
  const se = rt.s.sessions[turn.sessionId];
  if (live.current) offsetAt(rts, live, live.current, live.offset, true);
  // Postbox is shutting down: the turn goes on on the host, and is attached again after the restart.
  if (rt.closing || !se?.remoteTurn || se.remoteTurn.rtTurn !== turn.id) return err;
  // Its cards nobody waits on (shown before a restart, not sent again) can’t be answered now.
  for (const t of live.hostTurns) for (const card of openCards(rts, t)) if (!rt.permissionWaits.has(card.it.id)) endCard(rts, card, 'expired', '', rts.now());
  if (live.hung) return err;
  return endedHow(rts, live, se, err);
}

/**
 * The rest of ended, for a turn that wasn’t stopped as hung.
 * @param {RemoteTurns} rts @param {Live} live @param {any} se @param {any} err
 */
function endedHow(rts, live, se, err) {
  const name = rts.rt.s.hosts?.[live.hostId]?.name ?? 'the host';
  // No `ended` came for it, and it may be on the host: its runner may still be there, so it’s asked to stop there,
  // and that’s confirmed. One whose start never went (its preparation failed first) has nothing there to stop. A
  // sign-in error is a line from the host, so that turn’s start went.
  const unended = Boolean(live.current && live.exit === undefined && mayBeOnHost(live));
  if (live.signIn) {
    updateRemote(rts, se.id, { state: 'signin', at: rts.now(), resume: { why: 'signin', at: rts.now() } });
    if (unended) askStop(rts, se.id, live.hostId, /** @type {string} */ (live.current), { unconfirmed: unconfirmed(live) });
    rts.checkedAt.delete(se.id);
    return remoteError(`Sign-in needed on ${name}. Sign in there, then resume @${se.handle}.`, { state: 'signin', hostId: live.hostId });
  }
  if (live.exit === null) {
    updateRemote(rts, se.id, { state: 'interrupted', at: rts.now(), resume: { why: 'interrupted', at: rts.now() } });
    whenBack(rts, live.hostId);
    return remoteError(`Interrupted on ${name}: the agent’s process there ended without finishing its turn.`, { state: 'interrupted', hostId: live.hostId });
  }
  if (err && live.started && live.exit === undefined && !live.link?.connected) {
    // The link gave up with the turn still on the host, as far as Postbox knows: it’s attached again once the host is back.
    updateRemote(rts, se.id, { state: 'lost', at: rts.now() });
    rts.restoring.set(se.remoteTurn.turn, se.id);
    needHost(rts, live.hostId);
    return err;
  }
  const asked = Boolean(
    err && unended && askStop(rts, se.id, live.hostId, /** @type {string} */ (live.current), { state: true, unconfirmed: unconfirmed(live) }),
  );
  updateRemote(rts, se.id, { ...(asked ? {} : { state: 'done', at: rts.now() }), resume: null, ...(err ? {} : { autoResumes: 0 }) });
  return err;
}

/**
 * Stop on a remote turn: always a plain stop, through the daemon (the adapter’s stopTurn). A hung one says why.
 * @param {RemoteTurns} rts @param {any} turn @param {{ by?: string, why?: string }} o
 */
export function stopped(rts, turn, { by, why } = {}) {
  const live = /** @type {Live | undefined} */ (turn.remote);
  if (!live) return;
  const rt = rts.rt;
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
      askStop(rts, se.id, live.hostId, live.current, { send: false, unconfirmed: unconfirmed(live) }),
  );
  // Its process ends through the adapter (its child hears `ended`), but the turn is over here: what comes for it now
  // is refused, as a stopped turn’s calls are on the laptop (#126).
  forget(rts, live);
  if (live.current) offsetAt(rts, live, live.current, live.offset, true);
  if (!se) return;
  if (by === 'hung' && why) stoppedHung(rts, turn, live, se, why);
  else if (by !== 'shutdown' && se.remoteTurn && ON_HOST.has(se.remoteTurn.state))
    updateRemote(rts, se.id, { state: asked && rts.stopping.has(se.remoteTurn.turn) ? 'stopping' : 'done', at: rts.now(), resume: null });
}

/**
 * A turn Postbox stopped as hung says so: on the reply it stopped, or its last part when nothing was still streaming.
 * @param {RemoteTurns} rts @param {any} turn @param {Live} live @param {any} se @param {string} why
 */
function stoppedHung(rts, turn, live, se, why) {
  const rt = rts.rt;
  const own = rt.store.pending.items(turn.threadId).filter((/** @type {any} */ it) => it.turnId === turn.id && it.kind === 'agent');
  const stoppedHere = own.filter((/** @type {any} */ it) => it.status === 'stopped');
  for (const it of stoppedHere.length ? stoppedHere : own.slice(-1)) rt.patchItem(turn.threadId, it.id, { note: why });
  updateRemote(rts, se.id, { state: 'hung', at: rts.now(), message: why, resume: null });
  rt.tellAgent(se.id, `Postbox stopped your last turn on ${rt.s.hosts?.[live.hostId]?.name ?? 'the host'}: ${why.replace(/^Stopped: /, '')}.`);
  rt.notify('blocking', se, `@${se.handle} was stopped`, why, turn.threadId);
}

/** @param {RemoteTurns} rts @param {Live} live */
function forget(rts, live) {
  if (rts.live.get(live.sessionId) === live) rts.live.delete(live.sessionId);
  for (const t of live.hostTurns) if (rts.byTurn.get(t) === live) rts.byTurn.delete(t);
  rts.dirty.delete(live.sessionId);
  releaseHost(rts, live.hostId);
}
