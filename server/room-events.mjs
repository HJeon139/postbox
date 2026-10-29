// What the checks read of Postbox’s events (server/room-checks.mjs): items as they’re added, patched and moved, and
// sessions’ states and background jobs. The UAT’s history (tools/uat/history.mjs) and a recorded room’s collector
// (server/telemetry.mjs) both keep events cut this way, so the checks read the same thing from either.

/** The event, cut to what the checks read, or null for one they don’t (streamed text, apps, glossary…). */
export function keepEvent(seq, type, data) {
  // An item brought to the newest point (item.move) carries its update as a patch: a block’s new revision (#213).
  if (type === 'item.add' || type === 'item.patch' || type === 'item.move') return { seq, type, data };
  // A session event holds the whole session; the checks read only its state, and finishedAt, which a turn clears. The
  // triggers (tools/uat/triggers.mjs) also read Stop’s question about background jobs, and the jobs themselves (#126),
  // when the session has them.
  if (type === 'session' && data?.id)
    return {
      seq,
      type,
      data: {
        id: data.id,
        state: data.state ?? null,
        finishedAt: data.finishedAt ?? null,
        updatedAt: data.updatedAt ?? null,
        // The session’s catch-up marker, when the event carries it: marker-before-output reads where it moved (#508).
        ...(Object.hasOwn(data, 'seenItem') ? { seenItem: data.seenItem ?? null } : {}),
        ...(Object.hasOwn(data, 'stopAsk') ? { stopAsk: data.stopAsk ? { at: data.stopAsk.at ?? null, jobs: data.stopAsk.jobs ?? null } : null } : {}),
        ...(Array.isArray(data.jobs) ? { jobs: data.jobs.slice(0, 50).map(jobOf) } : {}),
        // A turn on a remote host (#120): which host, its turn there, and Postbox’s own turn, for the host-mode checks.
        ...(data.remoteTurn?.turn ? { remoteTurn: remoteOf(data.remoteTurn) } : {}),
      },
    };
  return null;
}

/** A session’s remote turn, cut to what the checks read (tools/uat/remote-facts.mjs). */
const remoteOf = (r) => ({ hostId: r.hostId ?? null, turn: r.turn, rtTurn: r.rtTurn ?? null, state: r.state ?? null });

/** A background job, cut to what the triggers read. */
const jobOf = (j) => ({ id: String(j?.id ?? ''), state: j?.state ?? null, kept: j?.kept === true, turnId: j?.turnId ?? null });
