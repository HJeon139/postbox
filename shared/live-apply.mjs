// How the page applies a running turn’s live frames (designs/architecture/live-progress.md, “Order” and “The
// buffer”), kept apart from the page’s modules so it can be tested in Node (app/js/live-frames.mjs is its glue). A
// frame goes through the reducer the page runs for stored events: a step as its item’s activityStep, a session’s live
// fields as its patch, so everything that draws a step or a session draws it as it always has.
// - A step frame applies only if its rev is newer than what the page has, so a late one can’t undo a newer one.
// - A frame for an item the page doesn’t hold yet (a range not loaded, an item.add still on its way) waits, at most
//   HELD_MOST of them, the oldest dropped first, and applies once the item is there.
// - A snapshot at load brings a page that joins mid-turn up to date.

import { EVENTS } from './state.mjs';

/** The most frames kept for items the page doesn’t hold yet. */
export const HELD_MOST = 200;

/**
 * One page’s applier: the revs it has applied, and the frames it’s holding.
 * @returns {{ apply: Function, flush: Function, snapshot: Function, held: () => number }}
 */
export function liveApplier() {
  /** @type {Map<string, number>} */
  const revs = new Map();
  /** @type {any[]} */
  let held = [];

  /** A step frame: applied, held, or dropped as older. @param {any} state @param {any} f @param {Function} has */
  function applyStep(state, f, has) {
    const key = `${f.itemId} ${f.step?.id}`;
    if (typeof f.rev === 'number' && f.rev <= (revs.get(key) ?? 0)) return [];
    if (!has(f.threadId, f.itemId)) {
      held.push(f);
      if (held.length > HELD_MOST) held = held.slice(-HELD_MOST);
      return [];
    }
    if (typeof f.rev === 'number') revs.set(key, f.rev);
    const data = { threadId: f.threadId, id: f.itemId, activityStep: f.step };
    EVENTS['item.patch'].apply(state, data);
    return [{ type: 'item.patch', data }];
  }

  /** A session frame: its live fields as the session’s patch. @param {any} state @param {any} f */
  function applySession(state, f) {
    const { kind, sessionId, ...patch } = f;
    if (!state.sessions[sessionId]) return [];
    EVENTS['session.patch'].apply(state, { id: sessionId, patch });
    return [{ type: 'session', data: state.sessions[sessionId] }];
  }

  return {
    /** A live frame: the changes to tell the page. @param {any} state @param {any} f @param {(threadId: string, id: string) => boolean} has */
    apply(state, f, has) {
      if (f?.kind === 'step') return applyStep(state, f, has);
      if (f?.kind === 'session') return applySession(state, f);
      return [];
    },
    /** The held frames whose items the page now holds. @param {any} state @param {(threadId: string, id: string) => boolean} has */
    flush(state, has) {
      const ready = held.filter((f) => has(f.threadId, f.itemId));
      if (!ready.length) return [];
      held = held.filter((f) => !ready.includes(f));
      return ready.flatMap((f) => applyStep(state, f, has));
    },
    /**
     * The running turns’ snapshots from /api/state: each step, then the session’s live fields.
     * @param {any} state @param {any[]} snaps @param {(threadId: string, id: string) => boolean} has
     */
    snapshot(state, snaps, has) {
      return (snaps ?? []).flatMap((s) => [
        ...(s.steps ?? []).flatMap((/** @type {any} */ step) => applyStep(state, { kind: 'step', threadId: s.threadId, itemId: s.itemId, step }, has)),
        ...(s.session && Object.keys(s.session).length ? applySession(state, { kind: 'session', sessionId: s.sessionId, ...s.session }) : []),
      ]);
    },
    held: () => held.length,
  };
}
