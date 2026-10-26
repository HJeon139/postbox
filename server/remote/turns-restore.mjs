// After a Postbox restart, and when Postbox gives up on a turn on a host (#120, server/remote/turns.mjs, the header):
// a turn that was running is attached again once the host’s welcome lists it, its cards stay open, and the stops
// asked before the restart are asked again; archive, delete and removing the host give up on what waits to attach
// or to resume.

import { needHost, releaseHost } from './turns-need.mjs';
import { endCard, openCards } from './turns-prompts.mjs';
import { interrupted, reattach, whenBack } from './turns-resume.mjs';
import { key, ON_HOST, sessionOfTurn, updateRemote } from './turns-shared.mjs';
import { askStop, dropStop } from './turns-stops.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */

/**
 * At startup: each session whose turn was on a host is attached again once the host’s welcome lists it, and one
 * that waits to resume waits again.
 * @param {RemoteTurns} rts
 */
export function restore(rts) {
  for (const se of Object.values(rts.rt.s.sessions)) {
    const r = se.remoteTurn;
    if (!r) continue;
    // Stops asked before the restart and not confirmed: asked again. A host removed since can’t be asked.
    for (const x of r.stopping ?? []) {
      if (rts.rt.s.hosts?.[x.hostId]) askStop(rts, se.id, x.hostId, x.turn, { unconfirmed: x.unconfirmed === true });
      else dropStop(rts, se.id, x.turn);
    }
    if (r.state === 'stopping' && !rts.stopping.has(r.turn)) updateRemote(rts, se.id, { state: 'done', at: rts.now() });
    if (ON_HOST.has(r.state)) {
      if (!rts.hosts || !rts.rt.s.hosts?.[r.hostId]) {
        interrupted(rts, se.id, 'Postbox can’t reach that host any more');
        continue;
      }
      rts.restoring.set(r.turn, se.id);
      needHost(rts, r.hostId);
      void reattach(rts, se.id);
    } else if (r.state === 'interrupted' && r.resume) whenBack(rts, r.hostId);
  }
}

/** Cards of a turn still on a host aren’t stale after a restart: the daemon sends their prompts again. @param {RemoteTurns} rts @param {any} it */
export function keepsCard(rts, it) {
  const se = it.remote?.turn ? sessionOfTurn(rts, it.remote.turn) : null;
  return Boolean(se && se.remoteTurn?.turn === it.remote.turn && ON_HOST.has(se.remoteTurn.state) && rts.hosts);
}

/**
 * Postbox gives up on a session’s turn on its host when nothing here is running it to Stop: one waiting to be
 * attached again (after a restart, or after its link gave up), and a resume waiting for the host. Archive, delete
 * and removing the host call it, after Stop, so nothing attaches or resumes for a conversation put away or a host
 * Postbox no longer knows. The host turn is asked to stop (the daemon stops it as a whole), now if the host is
 * connected, else at its next welcome; it’s in state `stopping`, not `done`, until the daemon confirms it (askStop).
 * Its cards can’t be answered any more. Returns whether there was a turn on the host to give up on.
 * @param {RemoteTurns} rts @param {string} sessionId
 */
export function cancel(rts, sessionId) {
  const se = rts.rt.s.sessions[sessionId];
  const r = se?.remoteTurn;
  if (!r || rts.live.has(sessionId)) return false;
  const pending = rts.restoring.get(r.turn) === sessionId;
  if (pending) {
    rts.restoring.delete(r.turn);
    rts.early.delete(r.turn);
  }
  const onHost = pending || ON_HOST.has(r.state);
  if (!onHost && !r.resume) return false;
  if (onHost) {
    for (const card of openCards(rts, r.turn)) {
      rts.endedPrompts.add(key(r.turn, card.it.remote.prompt));
      endCard(rts, card, 'expired', '', rts.now());
    }
  }
  const asked = onHost && askStop(rts, sessionId, r.hostId, r.turn, { state: true });
  updateRemote(rts, sessionId, { ...(asked ? {} : { state: 'done', at: rts.now() }), resume: null });
  rts.checkedAt.delete(sessionId);
  if (pending) releaseHost(rts, r.hostId);
  return onHost;
}
