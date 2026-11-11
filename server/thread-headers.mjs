// Every thread’s header facts (shared/thread-header.mjs, #1155), kept for /api/state and the stream. A thread’s facts
// are counted once, the first time its header is asked for, then kept current from each event alone: an added item is
// counted, a patched or moved one is looked at by its id. A topic or side thread’s facts from its conversation (the
// message it branched from, the link to it) change only with an event that names that item, found through an index of
// both. note() says which headers an event changed, so the stream sends a frame only for those.

import { itemOf } from '../shared/item-index.mjs';
import { addItem, checkAsk, headerFrom, noFacts } from '../shared/thread-header.mjs';

/** @typedef {import('../shared/thread-header.mjs').ThreadHeader} ThreadHeader */

/** How many notes between trims of the seqs kept for reconnecting streams. */
const TRIM_EVERY = 1000;

/** Every thread’s header, kept current from the store’s events. */
class ThreadHeaders {
  /** @param {{ state: any, events?: { seq: number }[] }} store */
  constructor(store) {
    this.store = store;
    /** @type {Map<string, import('../shared/thread-header.mjs').Facts>} */
    this.facts = new Map();
    /** Each header as last sent, as JSON, so an event that leaves it as it was sends nothing. @type {Map<string, string>} */
    this.sent = new Map();
    /** The seq of the event that last changed each header, so a reconnecting stream gets those it missed. @type {Map<string, number>} */
    this.changed = new Map();
    this.children = childIndex(store);
    this.notes = 0;
  }
  /** A thread’s items. @param {string} id @returns {any[]} */
  itemsOf(id) {
    return this.store.state.items?.[id] ?? [];
  }
  /** A thread’s facts, counted from its items the first time. @param {string} id */
  factsOf(id) {
    let f = this.facts.get(id);
    if (!f) {
      f = noFacts();
      for (const it of this.itemsOf(id)) {
        addItem(f, it);
        if (it.kind === 'sidelink') this.children.link(id, it);
      }
      this.facts.set(id, f);
    }
    return f;
  }
  /** The header of a thread that’s here, or null. @param {string} id @returns {ThreadHeader | null} */
  of(id) {
    const t = this.store.state.threads?.[id];
    if (!t) return null;
    const f = this.factsOf(id);
    const parent = t.parentId ? this.itemsOf(t.parentId) : [];
    if (t.parentId && t.kind === 'side') this.factsOf(t.parentId); // its count finds the links
    const root = t.kind === 'topic' ? itemOf(parent, t.rootItemId) : null;
    const link = t.kind === 'side' ? itemOf(parent, this.children.linkOf(id) ?? '') : null;
    return headerFrom(f, this.itemsOf(id), root, link, t.kind);
  }
  /** Applies an item event to its thread’s facts, if they’re kept; the threads whose headers it may change. @param {string} type @param {any} d */
  itemEvent(type, d) {
    const f = this.facts.get(d.threadId);
    const list = this.itemsOf(d.threadId);
    const id = type === 'item.add' ? d.item.id : d.id;
    if (f && type === 'item.add') addItem(f, d.item);
    if (f && type === 'item.add' && d.item.kind === 'sidelink') this.children.link(d.threadId, d.item);
    if (f && type !== 'item.add') checkAsk(f, itemOf(list, d.id));
    // A move leaves a stub in the item’s place and puts the item last: one more in the list (shared/state.mjs, moveItem).
    if (f && type === 'item.move') Object.assign(f, { count: f.count + 1, lastAt: list.at(-1)?.at ?? null });
    return [d.threadId, ...this.children.named(d.threadId, id)];
  }
  /** The threads an event may change the header of. @param {{ type: string, data?: any }} ev @returns {string[]} */
  touched(ev) {
    const d = ev.data ?? {};
    if (ev.type === 'item.add' || ev.type === 'item.patch' || ev.type === 'item.move') return this.itemEvent(ev.type, d);
    if (ev.type === 'thread') {
      this.children.thread(d);
      return [d.id];
    }
    if (ev.type === 'remove' && d.kind === 'thread') {
      this.facts.delete(d.id);
      return [d.id];
    }
    return [];
  }
  /** Every thread’s header, by id, as the page loads them: what the stream compares its frames with from now on. */
  all() {
    const out = Object.fromEntries(Object.keys(this.store.state.threads).map((id) => [id, this.of(id)]));
    for (const [id, h] of Object.entries(out)) this.sent.set(id, JSON.stringify(h));
    return out;
  }
  /**
   * The headers an event changed, each as it is now, or null for a thread it removed.
   * @param {{ seq: number, type: string, data?: any }} ev @returns {{ threadId: string, header: ThreadHeader | null }[]}
   */
  note(ev) {
    const out = [];
    for (const id of new Set(this.touched(ev))) {
      const header = this.of(id);
      const json = JSON.stringify(header);
      // Unchanged, or a thread the page never had a header of (one not here): nothing to say.
      if (this.sent.get(id) === json || (!header && !this.sent.has(id))) continue;
      if (header) this.sent.set(id, json);
      else this.sent.delete(id);
      this.changed.set(id, ev.seq);
      out.push({ threadId: id, header });
    }
    if (++this.notes % TRIM_EVERY === 0) this.trim();
    return out;
  }
  /** The threads whose header changed after `seq`, each as it is now. @param {number} seq */
  changedSince(seq) {
    return [...this.changed].filter(([, at]) => at > seq).map(([id]) => ({ threadId: id, header: this.of(id) }));
  }
  /** Lets go of the seqs no stream can still need: one behind the store’s oldest kept event loads the state again. */
  trim() {
    const oldest = this.store.events?.[0]?.seq ?? 0;
    for (const [id, at] of this.changed) if (at < oldest || !this.store.state.threads?.[id]) this.changed.delete(id);
  }
  /** Forgets them all: the state was replaced (a Retry), or a rejected event may have changed it unseen. */
  clear() {
    this.facts.clear();
    this.sent.clear();
    this.changed.clear();
    this.children.clear();
  }
}

/** @param {{ state: any, events?: { seq: number }[] }} store */
export const threadHeaders = (store) => new ThreadHeaders(store);

/**
 * Which topic and side threads hang off which items: a topic off the message it branched from, a side thread off its
 * link. Built from the threads on first use, then kept by the thread events and the links counted.
 * @param {{ state: any }} store
 */
function childIndex(store) {
  /** `${parentId}\n${itemId}` → the child thread. @type {Map<string, string> | null} */
  let byItem = null;
  /** A side thread → its link’s item id. @type {Map<string, string>} */
  const links = new Map();
  const key = (/** @type {string} */ parentId, /** @type {string} */ itemId) => `${parentId}\n${itemId}`;
  const index = () => {
    if (!byItem) {
      byItem = new Map();
      for (const t of Object.values(store.state.threads ?? {})) if (t.kind === 'topic' && t.parentId) byItem.set(key(t.parentId, t.rootItemId), t.id);
    }
    return byItem;
  };
  return {
    /** The child threads hanging off an item. @param {string} parentId @param {string} itemId @returns {string[]} */
    named(parentId, itemId) {
      const child = index().get(key(parentId, itemId));
      return child ? [child] : [];
    },
    /** A link item counted in a conversation. @param {string} parentId @param {any} it */
    link(parentId, it) {
      links.set(it.sideThreadId, it.id);
      index().set(key(parentId, it.id), it.sideThreadId);
    },
    /** @param {string} sideId */
    linkOf: (sideId) => links.get(sideId) ?? null,
    /** A thread made or changed: a topic’s place in the index. @param {any} t */
    thread(t) {
      if (t.kind === 'topic' && t.parentId) index().set(key(t.parentId, t.rootItemId), t.id);
    },
    clear() {
      byItem = null;
      links.clear();
    },
  };
}
