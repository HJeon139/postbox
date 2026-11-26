// A turn’s calls as its recorded stream has them (#1758, #1752), for an ATIF trajectory (tools/atif.mjs). A run made
// with POSTBOX_CLAUDE_RECORD keeps each Claude Code turn’s raw stream in streams/ (tools/uat/run-files.mjs,
// readStreams): every tool_use with its input, and every tool_result. Postbox shows a call as a step only when it has
// something to show, so a reaction or a deferred tool’s lookup made no step, and a trajectory built from steps alone
// left it out. A stream is named by its agent’s handle and when its turn’s process started, which is just after the
// work ledger’s entry for that turn started: so a stream is its agent’s latest turn that started at or before it did,
// and that turn names the session and the replies its calls go with. A call with a step goes with its step’s reply,
// and one with no step with the last call before it that has one, else with its turn’s first reply. A turn with no
// stream, one made on another backend, say, is counted, as its calls that made no step aren’t in the trajectory. Only
// Claude Code’s streams are read: the other backends record theirs in their own shapes (streams/kiro, agy, codex and
// sdk).

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
 * @typedef {{ id: string, sessionId: string, startedAt: number, toolCalls?: number }} AgentTurn
 * @typedef {{ id: string, turnId?: string, steps: Map<string, any> }} Reply
 */

/**
 * The turn a stream is of: its agent’s latest turn that started at or before the stream did, or null when none did.
 * @param {AgentTurn[]} turns @param {number | undefined} started
 */
function turnOf(turns, started) {
  if (typeof started !== 'number') return null;
  /** @type {AgentTurn | null} */
  let found = null;
  for (const t of turns) if (t.startedAt <= started && (!found || t.startedAt >= found.startedAt)) found = t;
  return found;
}

/**
 * Where a stream’s calls go: the turn of its first call that made a step, by that step’s reply, since a step names its
 * turn exactly; else, for a stream whose calls made none, its agent’s turn by time (turnOf). A recording with no work
 * ledger turns, from before the ledger kept them, places a stream with a step this way too, and one with none by the
 * first reply after it started and before its agent’s next stream did (placeByTime). Null when it has no turn; its
 * replies can be none, as for a turn stopped before it replied. @param {StreamCall[]} calls @param {Map<string, { session: string, reply: string }>} owner
 * @param {Map<string, Reply[]>} sessions @param {AgentTurn[]} turns @param {number | undefined} started
 * @param {number | undefined} next  when the agent’s next stream started
 * @returns {{ sessionId: string, turnId: string | null, replies: Reply[] } | null}
 */
function placeOf(calls, owner, sessions, turns, started, next) {
  const stepped = calls.map((c) => owner.get(c.id)).find(Boolean);
  if (stepped) {
    const replies = sessions.get(stepped.session) ?? [];
    const turnId = replies.find((it) => it.id === stepped.reply)?.turnId ?? null;
    const ofTurn = turnId ? replies.filter((it) => it.turnId === turnId) : replies.filter((it) => it.id === stepped.reply);
    return { sessionId: stepped.session, turnId, replies: ofTurn };
  }
  // A recording from before the ledger kept turns has nothing to match by but time.
  if (!turns.length) {
    const near = placeByTime(sessions, started, next);
    return near ? { sessionId: near.session, turnId: null, replies: (sessions.get(near.session) ?? []).filter((it) => it.id === near.reply) } : null;
  }
  const turn = turnOf(turns, started);
  return turn ? { sessionId: turn.sessionId, turnId: turn.id, replies: (sessions.get(turn.sessionId) ?? []).filter((it) => it.turnId === turn.id) } : null;
}

/**
 * Places one stream’s calls on its turn’s replies, in the session whose trajectory this is: a call with a step on its
 * step’s reply, and one with no step on the reply of the last call before it that has one, else the turn’s first.
 * @param {StreamCall[]} calls @param {Reply[]} replies  its turn’s @param {Map<string, { session: string, reply: string }>} owner
 * @param {string} sessionId @param {{ byId: Map<string, StreamCall>, unstepped: Map<string, StreamCall[]> }} into
 */
function placeCalls(calls, replies, owner, sessionId, { byId, unstepped }) {
  let at = replies[0].id;
  for (const c of calls) {
    const own = owner.get(c.id);
    if (own && own.session !== sessionId) continue;
    byId.set(c.id, c);
    if (own) at = own.reply;
    else unstepped.set(at, [...(unstepped.get(at) ?? []), c]);
  }
}

/**
 * What a session’s recorded streams add to its replies: each call’s recorded name, input and result by its id, the
 * calls that made no step by the reply they go with, how many of the session’s turns have no stream, and, on the first
 * of the agent’s sessions only, how many of its recorded calls have no turn with a reply to go with. A call two
 * streams hold is read once.
 * @param {{ handle: string, started?: number, events: any[] }[]} streams @param {string | null} handle
 * @param {{ sessions: Map<string, Reply[]>, turns: AgentTurn[] }} agent  each of the agent’s sessions’ replies, in
 *   order, by session, each with a trajectory, the first counting what has no turn (agentSessions); and its turns
 *   (agentTurns)
 * @param {string} sessionId  the session whose trajectory this is
 */
export function recordedCalls(streams, handle, { sessions, turns }, sessionId) {
  /** @type {Map<string, { session: string, reply: string }>} */
  const owner = new Map();
  for (const [session, replies] of sessions) for (const it of replies) for (const id of it.steps.keys()) owner.set(id, { session, reply: it.id });
  const into = { byId: new Map(), unstepped: new Map() };
  const seen = new Set();
  const streamed = new Set();
  let unplaced = 0;
  let seq = 0;
  const mine = streams.filter((s) => s.handle === handle).sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
  for (const [i, s] of mine.entries()) {
    const calls = callsInStream(s.events)
      .filter((c) => !seen.has(c.id))
      .map((c) => ({ ...c, seq: seq++ }));
    for (const c of calls) seen.add(c.id);
    const place = placeOf(calls, owner, sessions, turns, s.started, mine[i + 1]?.started);
    if (place?.turnId) streamed.add(place.turnId);
    if (!place?.replies.length) {
      if (sessionId === [...sessions.keys()][0]) unplaced += calls.length;
    } else if (place.sessionId === sessionId) placeCalls(calls, place.replies, owner, sessionId, into);
  }
  // A turn that called no tool has nothing a stream would add, so only one that did is a gap without its stream.
  const turnsWithoutStream = turns.filter((t) => t.sessionId === sessionId && (t.toolCalls ?? 0) > 0 && !streamed.has(t.id)).length;
  return { streamed: mine.length > 0, ...into, unplaced, turnsWithoutStream, ledgerTurns: turns.length > 0 };
}

/**
 * What a trajectory whose calls came from its turns’ streams says it lacks: the recorded calls that matched no reply,
 * and the turns of its session with no stream, whose calls that made no step it can’t have.
 * @param {{ unplaced: number, turnsWithoutStream: number, ledgerTurns?: boolean }} recorded
 */
function streamGaps({ unplaced, turnsWithoutStream: silent, ledgerTurns = true }) {
  const why = ledgerTurns
    ? 'matched no reply in any of its conversations'
    : 'matched no reply by time, and the recording has no work ledger turns to match their streams to';
  const notes = [
    unplaced ? ` ${unplaced} of this agent’s recorded calls ${why}, so ${unplaced === 1 ? 'it isn’t' : 'they aren’t'} in any trajectory.` : '',
    silent
      ? ` ${silent} of this agent’s turns in this conversation ${silent === 1 ? 'has' : 'have'} no Claude Code stream, so a call ${silent === 1 ? 'it' : 'they'} made that made no step isn’t in this trajectory.`
      : '',
  ];
  return { notes: notes.join(''), extra: { ...(unplaced ? { unplaced_calls: unplaced } : {}), ...(silent ? { turns_without_stream: silent } : {}) } };
}

/**
 * The reply a stream with no stepped call goes with, in a recording with no ledger turns: the first one added at or
 * after it started and before the next stream did, when exactly one of the agent’s sessions has one; else none, as the
 * stream could be either’s. @param {Map<string, { id: string, at?: number }[]>} sessions
 * @param {number | undefined} from @param {number | undefined} until
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
 * @param {{ notes: string, extra: any }} scope @param {{ streamed: boolean, unplaced: number, turnsWithoutStream: number }} recorded
 */
export function withCalls(scope, recorded) {
  if (!recorded.streamed)
    return {
      notes: `${scope.notes} Its calls are those that made a step in the conversation: one that made none, such as a reaction, isn’t in it, since the run has no Claude Code stream of this agent’s turns.`,
      extra: { ...scope.extra, calls_from: 'steps' },
    };
  const gaps = streamGaps(recorded);
  return { notes: scope.notes + gaps.notes, extra: { ...scope.extra, calls_from: 'recorded streams', ...gaps.extra } };
}
