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

/** A step’s key. @param {string} itemId @param {string} stepId */
const stepKey = (itemId, stepId) => `step\0${itemId}\0${stepId}`;
/** A session’s key. @param {string} sessionId */
const sessionKey = (sessionId) => `session\0${sessionId}`;

/** What each page’s stream was sent live: the running turns’ steps since their last commit points, and the sessions. */
export function liveSent() {
  /** @type {WeakMap<object, Set<string>>} */
  const sent = new WeakMap();
  /** @param {object} res @param {string} key */
  const note = (res, key) => {
    let keys = sent.get(res);
    if (!keys) sent.set(res, (keys = new Set()));
    keys.add(key);
  };
  return {
    /** A live frame’s key, by which a page notes it was sent it: its step’s, or its session’s. @param {any} frame */
    keyOf(frame) {
      if (frame.kind === 'step') return stepKey(frame.itemId, frame.step.id);
      return frame.kind === 'session' ? sessionKey(frame.sessionId) : null;
    },
    note,
    /**
     * A running turn’s snapshot a page’s stream was sent on connecting: it has the turn’s steps and its session as they
     * are. @param {object} res @param {any} snap  as publicLive gives it, or a session frame of it
     */
    noteSnapshot(res, snap) {
      for (const st of snap.steps ?? []) note(res, stepKey(snap.itemId, st.id));
      note(res, sessionKey(snap.sessionId));
    },
    /**
     * What a page may have of an event live, asked once an event: null for an event no page gets live instead, or the
     * key of the step or session it was marked for. @param {any} ev @returns {string | null}
     */
    marked(ev) {
      if (!committed.has(ev.data)) return null;
      return ev.type === 'session.patch' ? sessionKey(ev.data.id) : stepKey(ev.data.id, ev.data.activityStep.id);
    },
    /**
     * Whether a page has a marked event live. A session’s change: the stream has been sent the session’s frames, every
     * one of which goes to every stream, so it gets the frame that carries the change right after. A commit point: the
     * stream was sent the step live since the last one, which it forgets, so the next commit point of it asks again.
     * @param {object} res @param {string} key
     */
    /**
     * A reply’s turn ended: a stream forgets the steps of it it was sent, which a commit point held behind a commit,
     * released unmarked, would otherwise leave. @param {object} res @param {string} itemId
     */
    forget(res, itemId) {
      const keys = sent.get(res);
      if (!keys) return;
      const prefix = stepKey(itemId, '');
      for (const k of keys) if (k.startsWith(prefix)) keys.delete(k);
    },
    had(res, key) {
      const keys = sent.get(res);
      if (!keys) return false;
      return key.startsWith('session\0') ? keys.has(key) : keys.delete(key);
    },
  };
}
