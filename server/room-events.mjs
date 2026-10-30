// What the checks read of Postbox’s events (server/room-checks.mjs): items as they’re added, patched and moved, and
// sessions’ states and background jobs. The UAT’s history (tools/uat/history.mjs) and a recorded room’s collector
// (server/telemetry.mjs) both keep events cut this way, so the checks read the same thing from either.

import { patchSession } from '../shared/state.mjs';

/**
 * The event, cut to what the checks read, or null for one they don’t (streamed text, apps, glossary…). A session.patch
 * (designs/508, “Store events”) is kept as the whole session it leaves, so the checks read sessions as they always
 * did: sessions holds each session as the events so far left it, by id. A patch for a session that isn’t there (a
 * stream that started after the session existed) is dropped, as the reducer drops it, rather than kept as a session
 * built from the patch alone, which blockHistory would misread: seed sessions from the state or a snapshot first.
 * @param {number} seq @param {string} type @param {any} data @param {Map<string, any>} [sessions]
 */
export function keepEvent(seq, type, data, sessions = new Map()) {
  if (type === 'session.patch' && data?.id) {
    const was = sessions.get(data.id);
    return was ? keepEvent(seq, 'session', patchSession(was, data), sessions) : null;
  }
  // An item brought to the newest point (item.move) carries its update as a patch: a block’s new revision (#213).
  if (type === 'item.add' || type === 'item.patch' || type === 'item.move') return { seq, type, data };
  // A session event holds the whole session; the checks read only its state, and finishedAt, which a turn clears. The
  // triggers (tools/uat/triggers.mjs) also read Stop’s question about background jobs, and the jobs themselves (#126),
  // when the session has them.
  if (type === 'session' && data?.id) {
    sessions.set(data.id, data);
    return {
      seq,
      type,
      data: {
        id: data.id,
        state: data.state ?? null,
        finishedAt: data.finishedAt ?? null,
        updatedAt: data.updatedAt ?? null,
        ...(Object.hasOwn(data, 'stopAsk') ? { stopAsk: data.stopAsk ? { at: data.stopAsk.at ?? null, jobs: data.stopAsk.jobs ?? null } : null } : {}),
        ...(Array.isArray(data.jobs) ? { jobs: data.jobs.slice(0, 50).map(jobOf) } : {}),
        // A turn on a remote host (#120): which host, its turn there, and Postbox’s own turn, for the host-mode checks.
        ...(data.remoteTurn?.turn ? { remoteTurn: remoteOf(data.remoteTurn) } : {}),
      },
    };
  }
  return null;
}

/** A session’s remote turn, cut to what the checks read (tools/uat/remote-facts.mjs). */
const remoteOf = (r) => ({ hostId: r.hostId ?? null, turn: r.turn, rtTurn: r.rtTurn ?? null, state: r.state ?? null });

/** A background job, cut to what the triggers read. */
const jobOf = (j) => ({ id: String(j?.id ?? ''), state: j?.state ?? null, kept: j?.kept === true, turnId: j?.turnId ?? null });
