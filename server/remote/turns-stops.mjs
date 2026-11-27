// Stops the daemon confirms (#120, server/remote/turns.mjs, the header): a turn Postbox asked its host to stop may run
// on until the daemon says it’s over, so the stop is kept on the session, the host is needed, and the stop goes again
// at each welcome. Removing a host waits for these (confirmStops), and renaming one refuses while any is left (busyOn).
// A session removed while one is unconfirmed leaves it in its host’s record (`hostStops`, keepStops), which outlives
// sessions, so a restart asks it again and a deleted persona’s removal there stays held (#1796).

import { clockStopConfirmed } from '../run-clock.mjs';
import { hostOf } from './placement.mjs';
import { linkOf, listen, needHost, releaseHost } from './turns-need.mjs';
import { openCards } from './turns-prompt-cards.mjs';
import { ON_HOST, remoteOf, send, updateRemote } from './turns-shared.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */
/** @typedef {import('./turns-shared.mjs').Stop} Stop */

/**
 * Asks a host to stop one of its turns, and keeps asking, at each welcome, until the daemon says it’s over (its
 * `ended`, a no-turn answer, or a welcome that doesn’t list it running): until then it may still run there. It’s
 * kept on the session (remoteTurn.stopping), so a restart asks again, and the host is needed, so its link
 * reconnects. send: false when the adapter’s child sends this stop itself; state: the session’s turn is in state
 * `stopping` until then; unconfirmed: as on Stop, for a stop asked first (restore passes the saved one); byPerson: the
 * person’s Stop, the one stop that marks its cards, so their note says the Stop withdrew the request (#721, #853).
 * kept: a stop from the host’s record, whose session is gone (restore, #1796), with personaId, whose turn it is.
 * Returns false without a host manager, when nothing can be asked.
 * @param {RemoteTurns} rts @param {string | null} sessionId @param {string} hostId @param {string} turn
 * @param {{ send?: boolean, state?: boolean, unconfirmed?: boolean, byPerson?: boolean, kept?: { personaId?: string } }} [o]
 */
export function askStop(rts, sessionId, hostId, turn, { send: now = true, state = false, unconfirmed = false, byPerson = false, kept } = {}) {
  if (!rts.hosts) return false;
  let s = rts.stopping.get(turn);
  if (!s) {
    const personaId = kept ? kept.personaId : remoteOf(rts, sessionId ?? '')?.personaId;
    s = { sessionId, hostId, waiters: [], unconfirmed, personaId, kept: Boolean(kept) };
    rts.stopping.set(turn, s);
    needHost(rts, hostId);
  }
  const entry = stopEntry({ turn, hostId, at: rts.now() }, s);
  // Added to the stops as written, so one asked behind a held commit isn’t dropped (#623). A kept stop’s session is
  // gone (#1796).
  if (sessionId)
    updateRemote(rts, sessionId, (r) => {
      const stopping = r.stopping ?? [];
      return {
        ...(stopping.some((/** @type {any} */ x) => x.turn === turn) ? {} : { stopping: [...stopping, entry] }),
        ...(state && r.turn === turn ? { state: 'stopping', at: rts.now() } : {}),
      };
    });
  // The person’s Stop: its open cards learn it, so whichever message ends them tells the agent the Stop withdrew the
  // request, not the person refusing it (#853). Any other stop (a sign-in end, an errored end, a hung stop, the
  // restart’s re-ask) leaves them, so the agent hears it expired (#721).
  // A question’s blocks (#1059) aren’t cards: they stay asking.
  if (byPerson)
    for (const card of openCards(rts, turn)) if (card.it.kind === 'permission') rts.rt.threads.patchItem(card.threadId, card.it.id, { stoppedBy: 'you' });
  if (now) sendStop(rts, turn);
  return true;
}

/** Sends a stop Postbox is waiting on, if the host is connected now. @param {RemoteTurns} rts @param {string} turn */
export function sendStop(rts, turn) {
  const s = rts.stopping.get(turn);
  if (!s) return false;
  /** @type {any} */
  let link = null;
  try {
    link = linkOf(rts, s.hostId);
  } catch {}
  return Boolean(link?.connected) && send(link, 'stop', { turn });
}

/**
 * The daemon says a turn Postbox asked to stop is over, or isn’t there. unkilled: it said the turn’s runner outlived its
 * kill (#872), so the turn may still be working there.
 * @param {RemoteTurns} rts @param {string} turn @param {boolean} [unkilled]
 */
export function stopConfirmed(rts, turn, unkilled = false) {
  const s = rts.stopping.get(turn);
  if (!s) return;
  rts.stopping.delete(turn);
  dropStop(rts, s.sessionId, turn);
  // Its session was removed meanwhile: its host’s record lets it go (#1796).
  if (s.kept) rts.rt.store.emit('host.forget', { id: s.hostId, stopEnded: turn });
  // With run clocks on, a clock that paused or expired while this turn could still run on the host hears it’s over. One
  // whose runner outlived its kill may still be working, so its timed run is void, as for a CLI here (#1526).
  // A stop with no session has no clock to tell.
  if (rts.rt.runClock && s.sessionId) clockStopConfirmed(rts.rt, s.sessionId, turn, rts.now(), unkilled ? 'unkilled' : undefined);
  releaseHost(rts, s.hostId);
  for (const w of s.waiters) w();
  // A deleted persona’s memory there waits for its turns there to end (#1680).
  for (const heard of rts.stopsEnded) heard(s.hostId);
}

/**
 * A session is being removed: each of its stops the host hasn’t confirmed is kept in the host’s record, which outlives
 * sessions, so a restart asks it again, and a deleted persona’s removal there waits for it (#1796, #1680).
 * @param {RemoteTurns} rts @param {string} sessionId
 */
export function keepStops(rts, sessionId) {
  for (const [turn, s] of rts.stopping) {
    if (s.sessionId !== sessionId) continue;
    s.kept = true;
    rts.rt.store.emit('host.forget', { id: s.hostId, stop: { turn, personaId: s.personaId, unconfirmed: s.unconfirmed, at: rts.now() } });
  }
}

/**
 * A stop’s flags changed: its entry in remoteTurn.stopping says so, for a restart. One whose session is gone keeps the
 * flag its host’s record has, which only makes a welcome that doesn’t list the turn wait for the stop’s own answer.
 * @param {RemoteTurns} rts @param {string | null} sessionId @param {string} turn
 */
export function saveStop(rts, sessionId, turn) {
  if (!sessionId) return;
  const s = rts.stopping.get(turn);
  // The stops as written: one asked behind a held commit is saved too, and none is dropped (#623).
  const r = remoteOf(rts, sessionId)?.remoteTurn;
  if (!s || !r?.stopping?.some((/** @type {any} */ x) => x.turn === turn)) return;
  updateRemote(rts, sessionId, (now) => ({
    stopping: (now.stopping ?? []).map((/** @type {any} */ x) => (x.turn === turn ? stopEntry({ turn: x.turn, hostId: x.hostId, at: x.at }, s) : x)),
  }));
}

/** @param {RemoteTurns} rts @param {string | null} sessionId @param {string} turn */
export function dropStop(rts, sessionId, turn) {
  if (!sessionId) return;
  // Taken from the stops as written, so another stop or a state held behind a commit isn’t undone (#623).
  updateRemote(rts, sessionId, (r) => ({
    stopping: (r.stopping ?? []).filter((/** @type {any} */ x) => x.turn !== turn),
    ...(r.turn === turn && r.state === 'stopping' ? { state: 'done', at: rts.now() } : {}),
  }));
}

/**
 * For removing a host: waits up to waitMs for the daemon to confirm every stop Postbox asked of it, asking again now
 * if the host is connected, or connecting first, so the stops go at its welcome. Returns the host turns still not
 * confirmed, with noToken when this Postbox has no token for the host (not-installed): nothing can reach it, so
 * nothing waits, and the stops stay, since a missing token says nothing about whether those turns still run.
 * @param {RemoteTurns} rts @param {string} hostId @param {number} waitMs @returns {Promise<{ left: string[], noToken: boolean }>}
 */
export async function confirmStops(rts, hostId, waitMs) {
  const left = () => [...rts.stopping].filter(([, s]) => s.hostId === hostId).map(([t]) => t);
  if (!left().length || !rts.hosts) return { left: left(), noToken: false };
  /** @type {any} */
  let link = null;
  try {
    link = rts.hosts.link(hostId);
  } catch (e) {
    if (e?.code === 'not-installed') return { left: left(), noToken: true };
  }
  listen(rts, hostId);
  const all = Promise.all(left().map((t) => new Promise((r) => rts.stopping.get(t)?.waiters.push(() => r(undefined)))));
  // Connected, each is asked again, as at a welcome (a stop the adapter’s child sent may have been lost with it).
  if (link?.connected) for (const t of left()) sendStop(rts, t);
  else if (link) rts.hosts.ensureWelcome(hostId).catch(() => {});
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
 * @param {RemoteTurns} rts @param {string} hostId
 */
export function busyOn(rts, hostId) {
  if ([...rts.live.values()].some((l) => l.hostId === hostId)) return true;
  if ([...rts.stopping.values()].some((s) => s.hostId === hostId)) return true;
  return Object.values(rts.rt.s.sessions).some((se) => {
    const r = se.remoteTurn;
    if (r?.hostId !== hostId) return false;
    if (ON_HOST.has(r.state) || r.state === 'stopping' || rts.restoring.has(r.turn)) return true;
    // A resume goes only to the host it stopped on, for an agent still placed there (autoResume).
    return Boolean(r.resume) && hostOf(rts.rt.personas.forSession(se)) === hostId;
  });
}

/**
 * A stop’s entry in remoteTurn.stopping, with its flag only when it’s set.
 * @param {{ turn: string, hostId: string, at: number }} base @param {{ unconfirmed: boolean }} s
 */
function stopEntry(base, s) {
  return { ...base, ...(s.unconfirmed ? { unconfirmed: true } : {}) };
}
