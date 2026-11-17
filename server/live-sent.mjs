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
 * What each page’s stream was sent live: the steps of each reply since their last commit points, by reply, and the
 * sessions. A record per stream, made on its first live frame.
 */
export function liveSent() {
  /** @type {WeakMap<object, { steps: Map<string, Set<string>>, sessions: Set<string> }>} */
  const sent = new WeakMap();
  /** @param {object} res */
  const recordOf = (res) => {
    let r = sent.get(res);
    if (!r) sent.set(res, (r = { steps: new Map(), sessions: new Set() }));
    return r;
  };
  /** @param {object} res @param {string} itemId @param {string} stepId */
  const noteStep = (res, itemId, stepId) => {
    const { steps } = recordOf(res);
    let ids = steps.get(itemId);
    if (!ids) steps.set(itemId, (ids = new Set()));
    ids.add(stepId);
  };
  return {
    /** A live frame a page’s stream was sent: its step, or its session. @param {object} res @param {any} frame */
    note(res, frame) {
      if (frame.kind === 'step') noteStep(res, frame.itemId, frame.step.id);
      else if (frame.kind === 'session') recordOf(res).sessions.add(frame.sessionId);
    },
    /**
     * A running turn’s snapshot a page’s stream was sent on connecting: it has the turn’s steps and its session as they
     * are. @param {object} res @param {any} snap  as publicLive gives it, or a session frame of it
     */
    noteSnapshot(res, snap) {
      for (const st of snap.steps ?? []) noteStep(res, snap.itemId, st.id);
      recordOf(res).sessions.add(snap.sessionId);
    },
    /** Whether an event is one a page may have live instead, asked once an event. @param {any} ev */
    marked: (ev) => committed.has(ev.data),
    /**
     * Whether a page has a marked event live. A session’s change: the stream has been sent the session’s frames, every
     * one of which goes to every stream, so it gets the frame that carries the change right after. A commit point: the
     * stream was sent the step live since the last one, which it forgets, so the next commit point of it asks again.
     * @param {object} res @param {any} ev
     */
    had(res, ev) {
      const r = sent.get(res);
      if (!r) return false;
      if (ev.type === 'session.patch') return r.sessions.has(ev.data.id);
      return r.steps.get(ev.data.id)?.delete(ev.data.activityStep.id) ?? false;
    },
    /**
     * A reply’s turn ended: a stream forgets the steps of it it was sent, which a commit point held behind a commit,
     * released unmarked, would otherwise leave. @param {object} res @param {string} itemId
     */
    forget(res, itemId) {
      sent.get(res)?.steps.delete(itemId);
    },
  };
}
