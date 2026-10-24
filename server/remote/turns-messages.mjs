// The host’s messages for its remote turns (#120, server/remote/turns.mjs, the header): each welcome sends the
// snapshot again and asks again the stops Postbox waits on, and each message the daemon sends for a turn goes to the
// module that handles it.

import { onError, onPrompt, onPromptExpired } from './turns-prompts.mjs';
import { EARLY_MESSAGES } from './turns-shared.mjs';
import { sendSnapshot } from './turns-snapshot.mjs';
import { offsetAt } from './turns-start.mjs';
import { saveStop, sendStop, stopConfirmed } from './turns-stops.mjs';
import { onTool } from './turns-tools.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */

/**
 * A welcome: the snapshot goes again in full, and the quiet clock starts again, since the link was down. A turn
 * asked to stop that the welcome lists ended or interrupted is over, and so is one it doesn’t list, unless its start
 * went unconfirmed (that start may still reach the daemon, from the channel that dropped). The rest are asked again.
 * @param {RemoteTurns} rts @param {string} hostId @param {any} [welcome]
 */
export function onConnected(rts, hostId, welcome) {
  for (const live of rts.live.values()) {
    if (live.hostId !== hostId || !live.current) continue;
    live.lastEvent = Math.max(live.lastEvent, rts.now());
    sendSnapshot(rts, live, live.current);
  }
  const w = welcome ?? rts.hosts?.status(hostId)?.welcome ?? null;
  for (const [turn, s] of [...rts.stopping]) {
    if (s.hostId !== hostId) continue;
    const listed = Array.isArray(w?.turns) ? w.turns.find((/** @type {any} */ t) => t.turn === turn) : undefined;
    if (Array.isArray(w?.turns) && listed?.state !== 'running' && (listed || !s.unconfirmed)) stopConfirmed(rts, turn);
    else sendStop(rts, turn);
  }
}

/** @param {RemoteTurns} rts @param {string} hostId @param {any} m */
export function onHostMessage(rts, hostId, m) {
  if (typeof m?.turn !== 'string') return;
  // A turn being attached hears these once its attach has started, in the order they came.
  if (!rts.byTurn.has(m.turn) && rts.restoring.has(m.turn) && ['tool', 'prompt', 'prompt-expired', 'error'].includes(m.type)) {
    const list = rts.early.get(m.turn) ?? [];
    if (list.length < EARLY_MESSAGES) list.push(m);
    rts.early.set(m.turn, list);
    return;
  }
  switch (m.type) {
    case 'line':
      if (m.log !== 'in') sawLine(rts, m);
      return;
    case 'ended':
      stopConfirmed(rts, m.turn);
      return sawEnded(rts, m);
    case 'started':
      return sawStarted(rts, m.turn);
    case 'tool':
      return void onTool(rts, hostId, m);
    case 'prompt':
      return onPrompt(rts, hostId, m);
    case 'prompt-expired':
      return onPromptExpired(rts, m);
    case 'error':
      // A start sent again that was there already: it reached the host.
      if (m.re === 'start' && m.code === 'turn-exists') sawStarted(rts, m.turn);
      // The daemon has no such turn, and refuses its start from now on: one Postbox asked to stop won’t run there.
      if (m.re === 'stop' && m.code === 'no-turn') stopConfirmed(rts, m.turn);
      return onError(rts, m);
  }
}

/** The daemon has the turn: its start is confirmed, for the live turn and for a stop waiting on it. @param {RemoteTurns} rts @param {string} turn */
function sawStarted(rts, turn) {
  const live = rts.byTurn.get(turn);
  if (live && turn === live.current) live.started = true;
  const s = rts.stopping.get(turn);
  if (s?.unconfirmed) {
    s.unconfirmed = false;
    saveStop(rts, s.sessionId, turn);
  }
}

/** A stdout line: a sign of life, and maybe the harness’s sign-in error. @param {RemoteTurns} rts @param {any} m */
function sawLine(rts, m) {
  const live = rts.byTurn.get(m.turn);
  if (!live) return;
  live.lastEvent = rts.now();
  if (live.signInError && !m.cut && matches(m.text, live.signInError)) live.signIn = true;
}

/** @param {RemoteTurns} rts @param {any} m */
function sawEnded(rts, m) {
  const live = rts.byTurn.get(m.turn);
  if (!live) return;
  if (m.turn === live.current) live.exit = m.exit;
  offsetAt(rts, live, m.turn, m.size, true);
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
