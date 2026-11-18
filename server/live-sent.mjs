// Which stored events a page already has live (designs/architecture/live-progress.md, “Commit points”): a commit point
// stores a step a page was sent live, field for field, and a running turn’s change of state rides on the session frame
// sent with it. A page that had either isn’t sent the stored event at all: a cursor would only move its place on, which
// its next numbered frame does, and a reconnect that replays the event changes nothing it has. So each change crosses
// the wire once, as before commit points. Only a page’s stream is spared it; a tool’s stream, which names no open
// conversations, reads the stored events whole. Why a page can’t miss what it’s spared:
// - a skipped event moves neither the page’s place nor its EventSource’s Last-Event-ID, so a reconnect gets it whole
//   in the backlog, and a new stream (a reload, a tab that joins) was sent nothing live, so it’s spared nothing;
// - a backlog is built from the store, never skipped, and only frames sent to a stream after it joined count;
// - an emit held behind a commit is released from its JSON, a copy, so it’s never marked and goes whole;
// - a page that drops a live frame it was sent (shared/live-apply.mjs, past its held frames) loads the state again.

/**
 * The data of the events a page gets live instead, which only server/live-buffer.mjs adds to: a commit point’s step, and
 * a session’s change a live frame carries.
 */
export const committed = new WeakSet();

/**
 * What each page’s stream was sent live: the steps of each reply since their last commit points, by reply; the span of
 * each part’s words, from where it was first sent them to where they reach; and the sessions. A record per stream,
 * made on its first live frame.
 */
export function liveSent() {
  /** @type {WeakMap<object, { steps: Map<string, Set<string>>, words: Map<string, { from: number, to: number }>, sessions: Set<string> }>} */
  const sent = new WeakMap();
  /** @param {object} res */
  const recordOf = (res) => {
    let r = sent.get(res);
    if (!r) sent.set(res, (r = { steps: new Map(), words: new Map(), sessions: new Set() }));
    return r;
  };
  /** @param {object} res @param {string} itemId @param {string} stepId */
  const noteStep = (res, itemId, stepId) => {
    const { steps } = recordOf(res);
    let ids = steps.get(itemId);
    if (!ids) steps.set(itemId, (ids = new Set()));
    ids.add(stepId);
  };
  /**
   * A part’s words a stream was sent, from `at`: they extend the span it has when they start within it, and start a new
   * one when they don’t, as a stream that joined mid-reply does. @param {object} res @param {string} itemId
   * @param {number} at @param {number} length
   */
  const noteWords = (res, itemId, at, length) => {
    const { words } = recordOf(res);
    const span = words.get(itemId);
    if (span && at >= span.from && at <= span.to) span.to = Math.max(span.to, at + length);
    else words.set(itemId, { from: at, to: at + length });
  };
  return {
    /** A live frame a page’s stream was sent: its step, its words, or its session. @param {object} res @param {any} frame */
    note(res, frame) {
      if (frame.kind === 'step') noteStep(res, frame.itemId, frame.step.id);
      else if (frame.kind === 'text') noteWords(res, frame.itemId, frame.at, frame.text.length);
      else if (frame.kind === 'session') recordOf(res).sessions.add(frame.sessionId);
    },
    /**
     * A running turn’s snapshot a page’s stream was sent on connecting: it has the turn’s steps and its session as they
     * are. @param {object} res @param {any} snap  as publicLive gives it, or a session frame of it
     */
    noteSnapshot(res, snap) {
      for (const st of snap.steps ?? []) noteStep(res, snap.itemId, st.id);
      if (snap.text) noteWords(res, snap.text.itemId, snap.text.at, snap.text.text.length);
      recordOf(res).sessions.add(snap.sessionId);
    },
    /** Whether an event is one a page may have live instead, asked once an event. @param {any} ev */
    marked: (ev) => committed.has(ev.data),
    /**
     * Whether a page has a marked event live. A session’s change: the stream has been sent the session’s frames, every
     * one of which goes to every stream, so it gets the frame that carries the change right after. A commit point of a
     * step: the stream was sent the step live since the last one, which it forgets, so the next commit point of it asks
     * again. A commit point of words: the stream was sent every one of them live.
     * @param {object} res @param {any} ev
     */
    had(res, ev) {
      const r = sent.get(res);
      if (!r) return false;
      if (ev.type === 'session.patch') return r.sessions.has(ev.data.id);
      // A commit point of words: the stream was sent all of them live, from their start to their end.
      if (ev.type === 'item.text') {
        const span = r.words.get(ev.data.id);
        return Boolean(span && span.from <= ev.data.at && span.to >= ev.data.at + ev.data.text.length);
      }
      return r.steps.get(ev.data.id)?.delete(ev.data.activityStep.id) ?? false;
    },
    /**
     * A reply’s turn ended: a stream forgets the steps of it it was sent, which a commit point held behind a commit,
     * released unmarked, would otherwise leave. @param {object} res @param {string} itemId
     */
    forget(res, itemId) {
      sent.get(res)?.steps.delete(itemId);
      sent.get(res)?.words.delete(itemId);
    },
  };
}
