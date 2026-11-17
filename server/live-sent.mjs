// Which stored events a page already has live (designs/architecture/live-progress.md, “Commit points”): a commit point
// stores a step a page was sent live, field for field, and a running turn’s change of state rides on the session frame
// sent with it. A page that had either isn’t sent the stored event at all: a cursor would only move its place on, which
// its next numbered frame does, and a reconnect that replays the event changes nothing it has. So each change crosses
// the wire once, as before commit points. Only a page’s stream is spared it; a tool’s stream, which names no open
// conversations, reads the stored events whole.

/**
 * The data of the events a page gets live instead, which only server/live-buffer.mjs adds to: a commit point’s step, and
 * a session’s change a live frame carries.
 */
export const committed = new WeakSet();

/** @param {string} itemId @param {string} stepId */
const keyOf = (itemId, stepId) => `${itemId}\0${stepId}`;

/** What each page’s stream was sent of the running turns’ steps since their last commit points. */
export function liveSent() {
  /** @type {WeakMap<object, Set<string>>} */
  const sent = new WeakMap();
  return {
    /** A live frame a page’s stream was sent. @param {object} res @param {any} frame */
    note(res, frame) {
      if (frame.kind !== 'step') return;
      let steps = sent.get(res);
      if (!steps) sent.set(res, (steps = new Set()));
      steps.add(keyOf(frame.itemId, frame.step.id));
    },
    /** Whether a page may get an event live instead: only such an event need be asked of each page. @param {any} ev */
    marked: (ev) => committed.has(ev.data),
    /**
     * Whether a page has an event live: a session’s carried change, or a commit point of a step this page was sent live
     * since the last one, which it forgets, so the next commit point of it asks again. @param {object} res @param {any} ev
     */
    had(res, ev) {
      if (!committed.has(ev.data)) return false;
      // A session’s stored change: the frame that carries it goes to every page right after it.
      if (ev.type === 'session.patch') return true;
      return sent.get(res)?.delete(keyOf(ev.data.id, ev.data.activityStep.id)) ?? false;
    },
  };
}
