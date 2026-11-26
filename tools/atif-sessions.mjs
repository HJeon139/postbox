// Which sessions get an ATIF trajectory (tools/atif.mjs), and an agent’s sessions with their replies, which its
// turns’ recorded streams are placed among (tools/atif-streams.mjs, #1758).

/** The items an agent session shows: each is one of its steps. */
const OWN_KINDS = new Set(['agent', 'block', 'app']);

/**
 * Every session that showed something, each of which has a trajectory: a reply, a block or an app, so one whose only
 * output was a block has one too, or a clock. @param {{ items: Map<string, any>, clocks: any[] }} f @returns {Set<string>}
 */
export function shownSessions(f) {
  const ids = new Set([...f.items.values()].filter((it) => OWN_KINDS.has(it.kind) && it.sessionId).map((it) => it.sessionId));
  for (const c of f.clocks) ids.add(c.data.sessionId);
  return ids;
}

/** A session’s replies, in the order they were added. @param {{ sessions: Map<string, any>, order: { id: string }[], items: Map<string, any> }} f @param {string} sessionId */
const repliesOf = (f, sessionId) => f.order.map(({ id }) => f.items.get(id)).filter((it) => it?.kind === 'agent' && it.sessionId === sessionId && it.steps);

/**
 * Each session of an agent’s handle that has a trajectory, with its replies, in the order the sessions came: one the
 * agent joined and showed nothing in has none, so it can’t be the first, which carries the count of calls that matched no reply.
 * @param {{ sessions: Map<string, any>, order: { id: string }[], items: Map<string, any>, clocks: any[] }} f @param {string | null} handle
 */
export function agentSessions(f, handle) {
  const shown = shownSessions(f);
  return new Map([...f.sessions].filter(([id, se]) => se.handle === handle && shown.has(id)).map(([id]) => [id, repliesOf(f, id)]));
}

/**
 * An agent’s turns, from the work ledger: each one’s id, its session and when it started, which its recorded stream is
 * matched by (tools/atif-streams.mjs, recordedCalls).
 * @param {{ work: Map<string, any>, sessions: Map<string, any> }} f @param {string | null} handle
 * @returns {{ id: string, sessionId: string, startedAt: number, toolCalls: number }[]}
 */
export function agentTurns(f, handle) {
  return [...f.work.values()]
    .filter((w) => w.kind === 'turn' && typeof w.startedAt === 'number' && (w.handle ?? f.sessions.get(w.sessionId)?.handle) === handle)
    .map((w) => ({ id: w.id, sessionId: w.sessionId, startedAt: w.startedAt, toolCalls: w.toolCalls ?? 0 }));
}

/**
 * What an agent’s recorded streams are placed among: its sessions with their replies (agentSessions), and its turns
 * (agentTurns). @param {Parameters<typeof agentSessions>[0] & Parameters<typeof agentTurns>[0]} f @param {string | null} handle
 */
export const agentOf = (f, handle) => ({ sessions: agentSessions(f, handle), turns: agentTurns(f, handle) });
