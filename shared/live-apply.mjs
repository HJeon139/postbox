// How the page applies a running turn’s live frames (designs/architecture/live-progress.md, “Order” and “The
// buffer”), kept apart from the page’s modules so it can be tested in Node (app/js/live-frames.mjs is its glue). A
// frame goes through the reducer the page runs for stored events: a step as its item’s activityStep, a session’s live
// fields as its patch, so everything that draws a step or a session draws it as it always has.
// - A step frame applies only if its rev is newer than what the page has, so a late one can’t undo a newer one.
// - A frame for an item the page doesn’t hold yet (a range not loaded, an item.add still on its way) waits, at most
//   HELD_MOST of them, and applies once the item is there. Past that the oldest is dropped, and the applier says so
//   (lost): the server doesn’t send a page a commit point of a step it sent live (server/live-sent.mjs), so a page
//   that dropped one loads the state again rather than miss it.
// - A text frame says where its words start (`at`). The page adds only what it lacks of them, and holds a frame that
//   starts past its text’s end until the words before it arrive, live or stored.
// - A snapshot at load brings a page that joins mid-turn up to date.

import { itemOf } from './item-index.mjs';
import { liveFrameOf } from './live-kinds.mjs';
import { EVENTS } from './state.mjs';

/** The most frames kept for items the page doesn’t hold yet. */
export const HELD_MOST = 200;

/**
 * The frames held for items the page doesn’t hold yet: at most HELD_MOST, the oldest dropped past that, and whether
 * one was since it was last asked.
 */
function heldFrames() {
  /** @type {any[]} */
  let held = [];
  let dropped = false;
  return {
    /** @param {any} f */
    add(f) {
      held.push(f);
      if (held.length <= HELD_MOST) return;
      held = held.slice(-HELD_MOST);
      dropped = true;
    },
    /** The held frames whose items the page now holds, taken out. @param {(f: any) => boolean} ready */
    take(ready) {
      const out = held.filter(ready);
      if (out.length) held = held.filter((f) => !out.includes(f));
      return out;
    },
    size: () => held.length,
    lost() {
      const was = dropped;
      dropped = false;
      return was;
    },
  };
}

/** How much text the page holds of an item. @param {any} state @param {any} f */
const textLength = (state, f) => (itemOf(state.items[f.threadId] ?? [], f.itemId)?.text ?? '').length;

/**
 * Whether a held frame can apply now: its item is there, and a text frame’s words start no further on than the text.
 * @param {any} state @param {any} f @param {Function} has
 */
const ready = (state, f, has) => has(f.threadId, f.itemId) && (f.kind !== 'text' || f.at <= textLength(state, f));

/**
 * A text frame: what the page lacks of its words added, or the frame held until it can apply.
 * @param {any} state @param {any} f @param {Function} has @param {ReturnType<typeof heldFrames>} held
 * @returns {{ type: string, data: any }[]}
 */
function applyText(state, f, has, held) {
  if (!ready(state, f, has)) {
    held.add(f);
    return [];
  }
  const before = textLength(state, f);
  const data = { threadId: f.threadId, id: f.itemId, text: f.text, at: f.at };
  EVENTS['item.text'].apply(state, data);
  return textLength(state, f) > before ? [{ type: 'item.text', data }] : [];
}

/**
 * One page’s applier: the revs it has applied, and the frames it’s holding.
 * @returns {{ apply: Function, flush: Function, snapshot: Function, held: () => number, lost: () => boolean }}
 */
export function liveApplier() {
  /** @type {Map<string, number>} */
  const revs = new Map();
  const held = heldFrames();

  /**
   * A step frame: applied, held, or dropped as older. @param {any} state @param {any} f @param {Function} has
   * @returns {{ type: string, data: any }[]}
   */
  function applyStep(state, f, has) {
    const key = `${f.itemId} ${f.step?.id}`;
    if (typeof f.rev === 'number' && f.rev <= (revs.get(key) ?? 0)) return [];
    if (!has(f.threadId, f.itemId)) {
      held.add(f);
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
    /** A live frame: the changes to tell the page. @param {any} state @param {any} frame @param {(threadId: string, id: string) => boolean} has */
    apply(state, frame, has) {
      const f = liveFrameOf(frame); // as the stream sent it, a list for a text frame (shared/live-kinds.mjs, wireOf)
      if (f?.kind === 'step') return applyStep(state, f, has);
      if (f?.kind === 'text') return applyText(state, f, has, held);
      if (f?.kind === 'session') return applySession(state, f);
      // A running turn’s live state, sent when the stream connects: as at load.
      if (f?.kind === 'snapshot') return this.snapshot(state, [f], has);
      return [];
    },
    /**
     * The held frames that can apply now: their items there, and a text frame’s words reached.
     * @param {any} state @param {(threadId: string, id: string) => boolean} has
     */
    flush(state, has) {
      return held.take((f) => ready(state, f, has)).flatMap((f) => (f.kind === 'text' ? applyText(state, f, has, held) : applyStep(state, f, has)));
    },
    /**
     * The running turns’ snapshots from /api/state: each step, the words since the last commit point, then the session’s
     * live fields.
     * @param {any} state @param {any[]} snaps @param {(threadId: string, id: string) => boolean} has
     */
    snapshot(state, snaps, has) {
      return (snaps ?? []).flatMap((s) => [
        ...(s.steps ?? []).flatMap((/** @type {any} */ step) => applyStep(state, { kind: 'step', threadId: s.threadId, itemId: s.itemId, step }, has)),
        ...(s.text ? applyText(state, { kind: 'text', threadId: s.threadId, itemId: s.itemId, ...s.text }, has, held) : []),
        ...(s.session && Object.keys(s.session).length ? applySession(state, { kind: 'session', sessionId: s.sessionId, ...s.session }) : []),
      ]);
    },
    held: () => held.size(),
    /** Whether a frame was dropped since this was last asked: the page then loads the state again. */
    lost: () => held.lost(),
  };
}
