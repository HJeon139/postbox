// A turn’s calls as its recorded stream has them (#1758, #1752), for an ATIF trajectory (tools/atif.mjs). A run made
// with POSTBOX_CLAUDE_RECORD keeps each Claude Code turn’s raw stream in streams/ (tools/uat/run-files.mjs,
// readStreams): every tool_use with its input, and every tool_result. Postbox shows a call as a step only when it has
// something to show, so a reaction or a deferred tool’s lookup made no step, and a trajectory built from steps alone
// left it out. A stream’s calls carry the same ids as the steps, so a stream belongs to the reply whose steps share its
// ids, and a call with no step goes with the call before it that has one. A stream none of whose calls made a step, a
// turn that only reacted, goes with the first reply added after it started and before the agent’s next stream did.
// Only Claude Code’s streams are read: the other backends record theirs in their own shapes (streams/kiro, agy, codex
// and sdk).

/** A tool_result’s content as text: a string, or its text parts joined. @param {unknown} content */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text);
  return parts.length ? parts.join('\n') : null;
}

/**
 * One stream’s calls in the order its turn made them, each with its input and, once its tool_result came, its result.
 * @param {any[]} events  the stream’s lines, parsed @returns {{ id: string, name: string, input: any, result: string | null }[]}
 */
export function callsInStream(events) {
  /** @type {Map<string, { id: string, name: string, input: any, result: string | null }>} */
  const calls = new Map();
  for (const e of events) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (e.type === 'assistant' && c?.type === 'tool_use' && typeof c.id === 'string')
        calls.set(c.id, { id: c.id, name: String(c.name ?? ''), input: c.input && typeof c.input === 'object' ? c.input : {}, result: null });
      const call = e.type === 'user' && c?.type === 'tool_result' ? calls.get(c.tool_use_id) : null;
      if (call) call.result = resultText(c.content);
    }
  }
  return [...calls.values()];
}

/**
 * What one session’s recorded streams add to its replies: each call’s recorded input and result by its id, the calls
 * that made no step by the reply they go with, and how many matched no reply. A stream is its agent’s handle’s, so only
 * those are read; one that shares no call with this session’s replies, and has none of them in its time, is another
 * session’s, and is counted, not placed.
 * @param {{ handle: string, started?: number, events: any[] }[]} streams @param {string | null} handle
 * @param {{ id: string, at?: number, steps: Map<string, any> }[]} replies  the session’s replies, in order
 */
export function recordedCalls(streams, handle, replies) {
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const it of replies) for (const id of it.steps.keys()) owner.set(id, it.id);
  /** @type {Map<string, { id: string, name: string, input: any, result: string | null }>} */
  const byId = new Map();
  /** @type {Map<string, { id: string, name: string, input: any, result: string | null }[]>} */
  const unstepped = new Map();
  let unplaced = 0;
  const mine = streams.filter((s) => s.handle === handle).sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
  for (const [i, s] of mine.entries()) {
    const calls = callsInStream(s.events);
    const first = calls.find((c) => owner.has(c.id));
    // Calls before the first one with a step go with that one’s reply, else with the reply its time holds; later ones
    // with the last one before them that has a step.
    let at = first ? owner.get(first.id) : replyIn(replies, s.started, mine[i + 1]?.started);
    if (!at) {
      unplaced += calls.length;
      continue;
    }
    for (const c of calls) {
      byId.set(c.id, c);
      if (owner.has(c.id)) at = owner.get(c.id);
      else if (at) unstepped.set(at, [...(unstepped.get(at) ?? []), c]);
    }
  }
  return { streamed: mine.length > 0, byId, unstepped, unplaced };
}

/**
 * The first reply added at or after a stream started and before the next one did, or null.
 * @param {{ id: string, at?: number }[]} replies @param {number | undefined} from @param {number | undefined} until
 */
function replyIn(replies, from, until = Number.POSITIVE_INFINITY) {
  if (typeof from !== 'number') return null;
  return replies.find((it) => typeof it.at === 'number' && it.at >= from && it.at < until)?.id ?? null;
}

/**
 * A trajectory’s scope, with where its calls came from: the turns’ recorded streams, or the conversation’s steps alone,
 * which leave out a call that made no step, such as a reaction (#1758).
 * @param {{ notes: string, extra: any }} scope @param {{ streamed: boolean, unplaced: number }} recorded
 */
export const withCalls = (scope, { streamed, unplaced }) => ({
  notes: streamed
    ? `${scope.notes}${unplaced ? ` ${unplaced} recorded ${unplaced === 1 ? 'call' : 'calls'} matched no reply, so ${unplaced === 1 ? 'it isn’t' : 'they aren’t'} in it.` : ''}`
    : `${scope.notes} Its calls are those that made a step in the conversation: one that made none, such as a reaction, isn’t in it, since the run recorded no stream of this agent’s turns.`,
  extra: { ...scope.extra, calls_from: streamed ? 'recorded streams' : 'steps', ...(unplaced ? { unplaced_calls: unplaced } : {}) },
});
