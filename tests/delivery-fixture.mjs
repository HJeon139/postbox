// Hand-built rooms for the delivery checks and triggers (#508). HAND-BUILT, not recorded: the recorded rooms these
// checks were first run on (UAT runs of 24 and 28 October 2026) hold the agents’ Claude Code transcripts, which can’t
// be committed. Every shape here is one those runs recorded, cut to the fields the checks read:
//   item.add { threadId, item }, item.patch { threadId, id, patch }   Postbox’s events (server/room-events.mjs)
//   session { id, seenItem, updatedAt }                                 a session event, as keepEvent keeps it
//   { handle, started, ended, events }                                  a turn’s raw stream (tools/uat/run-files.mjs);
//                                                                       its events cut to the init and, when the turn
//                                                                       said anything, its first assistant message
//   { handle, lines }                                                   a Claude Code transcript: each turn’s prompt as
//                                                                       a user line, each tool result as one too;
//                                                                       and the user lines Claude Code writes itself,
//                                                                       flagged isCompactSummary (a compaction’s
//                                                                       summary) or isMeta (a caveat or reminder), as
//                                                                       server/adapters/terminal-mirror.mjs reads them
// The texts paraphrase the p0 run of 28 October 2026, where a held mention never reached @researcher.

/** 23:06 UTC on 28 October 2026, when the p0 run began. */
export const T0 = Date.UTC(2026, 9, 28, 23, 6, 0);
export const ROOM = 'th_room';

/** A room with nothing in it yet, and what builds it up. */
export function room() {
  const f = {
    state: { items: { [ROOM]: [] }, personas: {}, sessions: {}, threads: { [ROOM]: { id: ROOM, kind: 'room', title: 'The release', members: [] } } },
    threads: [ROOM],
    events: [],
    streams: [],
    transcripts: [],
  };
  let seq = 0;
  const lines = (handle) => /** @type {any} */ (f.transcripts.find((t) => t.handle === handle)).lines;
  const line = (at, content, flags = {}) => JSON.stringify({ type: 'user', ...flags, timestamp: new Date(at).toISOString(), message: { content } });
  return {
    f,
    /**
     * An agent in the room, on a backend: its persona (state.personas, as server/room-checks-backends.mjs reads it),
     * and its transcript when it runs on Claude Code, the only backend a run records one of (tools/uat/run-files.mjs).
     */
    agent(handle, { backend = 'claude-code' } = {}) {
      const id = `se_${handle}`;
      f.state.personas[`pe_${handle}`] = { id: `pe_${handle}`, handle, backend };
      f.state.sessions[id] = { id, handle, personaId: `pe_${handle}`, threadId: ROOM, state: 'idle', needs: null, archived: false };
      f.state.threads[ROOM].members.push(id);
      if (backend === 'claude-code') f.transcripts.push({ handle, lines: [] });
      return id;
    },
    /** An item posted, as the state holds it and the history recorded it. */
    add(item) {
      f.state.items[ROOM].push({ ...item });
      f.events.push({ seq: ++seq, type: 'item.add', data: { threadId: ROOM, item: structuredClone(item) } });
      return item;
    },
    /** A change to an item. */
    patch(id, patch) {
      Object.assign(/** @type {any} */ (f.state.items[ROOM].find((i) => i.id === id)), structuredClone(patch));
      f.events.push({ seq: ++seq, type: 'item.patch', data: { threadId: ROOM, id, patch: structuredClone(patch) } });
    },
    /** A session’s catch-up marker moving, as Postbox does when it builds a turn’s prompt. */
    marker(handle, seenItem, at) {
      f.events.push({ seq: ++seq, type: 'session', data: { id: `se_${handle}`, seenItem, updatedAt: at } });
    },
    /** A user line Claude Code wrote itself, not a prompt: flags { isCompactSummary: true } or { isMeta: true }. */
    written(handle, at, content, flags) {
      lines(handle).push(line(at, content, flags));
    },
    /** A turn: its stream, its prompt and its tool results. output: false for one that wrote nothing. */
    turn(handle, started, { prompt = /** @type {string|null} */ (null), results = /** @type {string[]} */ ([]), output = true, ms = 8000 } = {}) {
      f.streams.push({ handle, started, ended: started + ms, events: [{ type: 'system', subtype: 'init' }, ...(output ? [{ type: 'assistant' }] : [])] });
      // An agent on another backend takes its turns all the same; no transcript records what they began with.
      if (!f.transcripts.some((t) => t.handle === handle)) return;
      if (prompt !== null) lines(handle).push(line(started + 5, prompt));
      for (const r of results) lines(handle).push(line(started + 1000, [{ type: 'tool_result', content: r }]));
    },
  };
}

export const ROUND_TWO =
  'Round 2 of the review is sent to @researcher, but Postbox is holding it. I accept four of the six changes: items 7, 12a, 12b and 14, and ask for two fixes.';
export const DRAFT =
  '@researcher please draft a short 2.0 release checklist, about 15 items across packaging, deprecations, docs, CI, security and a migration guide.';
