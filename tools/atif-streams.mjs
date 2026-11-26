// A turn’s calls as its recorded stream has them (#1758, #1752), for an ATIF trajectory (tools/atif.mjs). A run made
// with POSTBOX_CLAUDE_RECORD keeps each Claude Code turn’s raw stream in streams/ (tools/uat/run-files.mjs,
// readStreams): every tool_use with its input, and every tool_result. Postbox shows a call as a step only when it has
// something to show, so a reaction or a deferred tool’s lookup made no step, and a trajectory built from steps alone
// left it out. A stream’s calls carry the same ids as the steps, so a stream belongs to the reply whose steps share its
// ids, and a call with no step goes with the call before it that has one. A stream none of whose calls made a step, a
// turn that only reacted, goes with the first reply added after it started and before the agent’s next stream did,
// when only one of the agent’s sessions has one there: streams are named by handle, and one agent can be in several
// conversations. Only Claude Code’s streams are read: the other backends record theirs in their own shapes
// (streams/kiro, agy, codex and sdk).

/**
 * @typedef {{ id: string, name: string, input: any, result: string | null, isError: boolean, parent: string | null, seq: number }} StreamCall
 */

/** A tool_result’s content as text: a string, or its parts in order, a part that isn’t text named, as [image]. @param {unknown} content */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : `[${p?.type ?? 'part'}]`)).join('\n');
}

/**
 * One stream’s calls in the order its turn made them, each with its input, its tool_result once it came, whether that
 * was an error, and the call it was made under, for a subagent’s (`parent_tool_use_id`).
 * @param {any[]} events  the stream’s lines, parsed @returns {StreamCall[]}
 */
export function callsInStream(events) {
  /** @type {Map<string, StreamCall>} */
  const calls = new Map();
  for (const e of events) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (e.type === 'assistant' && c?.type === 'tool_use' && typeof c.id === 'string' && !calls.has(c.id)) {
        const input = c.input && typeof c.input === 'object' ? c.input : {};
        calls.set(c.id, { id: c.id, name: String(c.name ?? ''), input, result: null, isError: false, parent: e.parent_tool_use_id ?? null, seq: calls.size });
      }
      const call = e.type === 'user' && c?.type === 'tool_result' ? calls.get(c.tool_use_id) : null;
      if (call) Object.assign(call, { result: resultText(c.content), isError: c.is_error === true });
    }
  }
  return [...calls.values()];
}

/**
 * What a session’s recorded streams add to its replies: each call’s recorded name, input and result by its id, the
 * calls that made no step by the reply they go with, and, on the agent’s first session only, how many of its recorded
 * calls matched no reply in any of its sessions. A call two streams hold is read once.
 * @param {{ handle: string, started?: number, events: any[] }[]} streams @param {string | null} handle
 * @param {Map<string, { id: string, at?: number, steps: Map<string, any> }[]>} sessions  each of the agent’s sessions’
 *   replies, in order, by session; the first is the one that counts what matched none
 * @param {string} sessionId  the session whose trajectory this is
 */
export function recordedCalls(streams, handle, sessions, sessionId) {
  /** @type {Map<string, { session: string, reply: string }>} */
  const owner = new Map();
  for (const [session, replies] of sessions) for (const it of replies) for (const id of it.steps.keys()) owner.set(id, { session, reply: it.id });
  /** @type {Map<string, StreamCall>} */
  const byId = new Map();
  /** @type {Map<string, StreamCall[]>} */
  const unstepped = new Map();
  const seen = new Set();
  let unplaced = 0;
  let seq = 0;
  // Calls that match no reply are counted once, on the agent’s first session with a reply, which has a trajectory: a
  // session it joined and never replied in has none to carry the count.
  const holder = [...sessions].find(([, replies]) => replies.length > 0)?.[0] ?? [...sessions.keys()][0];
  const mine = streams.filter((s) => s.handle === handle).sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
  for (const [i, s] of mine.entries()) {
    const calls = callsInStream(s.events)
      .filter((c) => !seen.has(c.id))
      .map((c) => ({ ...c, seq: seq++ }));
    for (const c of calls) seen.add(c.id);
    const first = calls.find((c) => owner.has(c.id));
    const place = first ? owner.get(first.id) : placeByTime(sessions, s.started, mine[i + 1]?.started);
    if (!place) {
      if (sessionId === holder) unplaced += calls.length;
      continue;
    }
    if (place.session !== sessionId) continue;
    // Calls before the first one with a step go with its reply; later ones with the last one before them that has one.
    let at = place.reply;
    for (const c of calls) {
      const own = owner.get(c.id);
      if (own && own.session !== sessionId) continue;
      byId.set(c.id, c);
      if (own) at = own.reply;
      else unstepped.set(at, [...(unstepped.get(at) ?? []), c]);
    }
  }
  return { streamed: mine.length > 0, byId, unstepped, unplaced };
}

/**
 * The reply a stream with no stepped call goes with: the first one added at or after it started and before the next
 * stream did, when exactly one of the agent’s sessions has one; else none, as the stream could be either’s.
 * @param {Map<string, { id: string, at?: number }[]>} sessions @param {number | undefined} from @param {number | undefined} until
 */
function placeByTime(sessions, from, until = Number.POSITIVE_INFINITY) {
  if (typeof from !== 'number') return null;
  const found = [...sessions].flatMap(([session, replies]) => {
    const reply = replies.find((it) => typeof it.at === 'number' && it.at >= from && it.at < until);
    return reply ? [{ session, reply: reply.id }] : [];
  });
  return found.length === 1 ? found[0] : null;
}

/**
 * A trajectory’s scope, with where its calls came from: the turns’ recorded streams, or the conversation’s steps alone,
 * which leave out a call that made no step, such as a reaction (#1758).
 * @param {{ notes: string, extra: any }} scope @param {{ streamed: boolean, unplaced: number }} recorded
 */
export const withCalls = (scope, { streamed, unplaced }) => ({
  notes: streamed
    ? `${scope.notes}${unplaced ? ` ${unplaced} of this agent’s recorded calls matched no reply in any of its conversations, so ${unplaced === 1 ? 'it isn’t' : 'they aren’t'} in any trajectory.` : ''}`
    : `${scope.notes} Its calls are those that made a step in the conversation: one that made none, such as a reaction, isn’t in it, since the run recorded no stream of this agent’s turns.`,
  extra: { ...scope.extra, calls_from: streamed ? 'recorded streams' : 'steps', ...(unplaced ? { unplaced_calls: unplaced } : {}) },
});

/** A session’s replies, in the order they were added. @param {{ sessions: Map<string, any>, order: { id: string }[], items: Map<string, any> }} f @param {string} sessionId */
const repliesOf = (f, sessionId) => f.order.map(({ id }) => f.items.get(id)).filter((it) => it?.kind === 'agent' && it.sessionId === sessionId && it.steps);

/** Each session of an agent’s handle, with its replies, in the order the sessions came. @param {{ sessions: Map<string, any>, order: { id: string }[], items: Map<string, any> }} f @param {string | null} handle */
export const agentSessions = (f, handle) => new Map([...f.sessions].filter(([, se]) => se.handle === handle).map(([id]) => [id, repliesOf(f, id)]));
