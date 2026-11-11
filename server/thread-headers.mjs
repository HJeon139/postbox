// Every thread’s header facts (shared/thread-header.mjs, #1155), kept for /api/state and the stream. Each is computed
// when first asked for and kept until an event changes it: an item’s change in a thread changes that thread’s header and
// those of the topic and side threads hanging off it, whose facts are items of their conversation. Streamed text
// changes none of them.

import { headerOf } from '../shared/thread-header.mjs';

/** The event types that can change a header, beyond the item changes. */
const THREAD_EVENTS = new Set(['thread', 'remove', 'turn.archive']);

/**
 * The threads an event changes the header of; a thread’s removal is noted in `gone`.
 * @param {{ state: any }} store @param {Set<string>} gone @param {{ type: string, data?: any }} ev
 */
function touched(store, gone, ev) {
  const d = ev.data ?? {};
  const withChildren = (/** @type {string} */ id) => [id, ...childrenOf(store.state, id)];
  if (ev.type === 'turn.archive') return [...new Set((d.items ?? []).map((/** @type {any} */ r) => r.threadId))].flatMap(withChildren);
  if (ev.type === 'item.text' || !(ev.type.startsWith('item.') || THREAD_EVENTS.has(ev.type))) return [];
  if (ev.type === 'remove') {
    if (d.kind !== 'thread') return [];
    gone.add(d.id);
    return [d.id];
  }
  return withChildren(ev.type === 'thread' ? d.id : d.threadId);
}

/** The topic and side threads of a thread. @param {any} state @param {string} id */
function childrenOf(state, id) {
  return Object.values(state.threads ?? {})
    .filter((t) => t.parentId === id && (t.kind === 'side' || t.kind === 'topic'))
    .map((t) => t.id);
}

/** @param {{ state: any }} store */
export function threadHeaders(store) {
  /** @type {Map<string, import('../shared/thread-header.mjs').ThreadHeader>} */
  const kept = new Map();
  /** The seq of the event that last changed each thread’s header, so a reconnecting stream gets those it missed. */
  /** @type {Map<string, number>} */
  const changed = new Map();
  /** The threads a removal took, whose header frame says so with null. */
  const gone = new Set();

  return {
    /** The header of a thread that’s here, or null. @param {string} id */
    of(id) {
      if (!store.state.threads?.[id]) return null;
      let h = kept.get(id);
      if (!h) {
        h = headerOf(store.state, id);
        kept.set(id, h);
      }
      return h;
    },
    /** Whether a removal took the thread. @param {string} id */
    removed(id) {
      return gone.has(id);
    },
    /** Every thread’s header, by id. */
    all() {
      return Object.fromEntries(Object.keys(store.state.threads).map((id) => [id, this.of(id)]));
    },
    /** Forgets the headers an event changes, and returns their threads’ ids. @param {{ seq: number, type: string, data?: any }} ev */
    note(ev) {
      const ids = touched(store, gone, ev);
      for (const id of ids) {
        kept.delete(id);
        changed.set(id, ev.seq);
      }
      return ids;
    },
    /** The threads whose header changed after `seq`. @param {number} seq */
    changedSince(seq) {
      return [...changed].filter(([, at]) => at > seq).map(([id]) => id);
    },
    /** Forgets them all: the state was replaced (a Retry). */
    clear() {
      kept.clear();
      changed.clear();
      gone.clear();
    },
  };
}
