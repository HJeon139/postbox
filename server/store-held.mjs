// The pending read (#601, designs/508/601-held-view.md): a list as memory will hold it once the emits held behind a commit
// are released. An emit made while a commit is queued or in flight is held, not numbered, applied or broadcast until
// the commit settles (server/store.mjs; storage-design.md §6.3), and every held emit is released onto memory in order,
// whether the commit resolves or fails (store-commit.mjs, store-retry.mjs). The published state (store.state,
// store.items()) is what the page, the stream, the read tools and every other reader see (design.md, “visible to
// anything … only after its sync”; T-31). The pending read is for in-process code whose decision would be wrong on a
// list that held writes have superseded, each call site placed in tests/store-held-guard.test.mjs.
//
// It applies held emits without the commit in front of them, whose events don’t exist until the writer runs its
// builder, so it is exact only while no commit touches the list read: none does today; a commit kind that touches
// items or work is placed in the guard beside these readers. A pending item has no position yet (B1 assigns n at the
// release), so no pending reader may depend on one.
//
// A view is kept per list and grows as emits are held: while a commit is stuck in its fsync, a streaming reply holds
// an item.text per chunk and readers run per chunk, so each held event is applied once, not once per read. It is
// rebuilt when the state changes (record()), and dropped when nothing is held.

import { itemOf, positionOf } from '../shared/item-index.mjs';
import { apply } from '../shared/state.mjs';

/** The lists a pending read covers: the events that change one, the key they name it by, and how an add names its entry. */
const LISTS = /** @type {const} */ ({
  items: { events: ['item.add', 'item.patch', 'item.move', 'item.text'], key: 'threadId', added: (/** @type {any} */ d) => d.item?.id },
  work: { events: ['work.add', 'work.patch'], key: 'convId', added: (/** @type {any} */ d) => d.entry?.id },
});
/**
 * The collections of whole entities a pending read covers, keyed by id: the event that puts one whole (the reducer
 * replaces it), and the `remove` kind that deletes it. An app is read back by the turn that shows, updates or retires it.
 */
const ENTITIES = /** @type {const} */ ({
  apps: { event: 'app', removed: 'app' },
  // A topic the turn or the page may have just opened (#637): startTopic reads it to make one topic per message. Every
  // write of a thread starts from it (#796, server/thread-write.mjs).
  threads: { event: 'thread', removed: 'thread' },
});
/** @typedef {keyof typeof LISTS} PendingList */
/** @typedef {keyof typeof ENTITIES} PendingCollection */
/** @typedef {any} Entry  an item, a work entry or an app, as the reducer keeps it: their shapes aren’t typed yet (shared/state.mjs) */
/**
 * @typedef {{ [K in PendingList]: (key: string) => readonly Entry[] } & {
 *   app: (id: string) => Entry | undefined,
 *   item: (threadId: string, id: string) => Entry | undefined,
 *   apps: () => Readonly<Record<string, Entry>>,
 *   thread: (id: string) => Entry | undefined,
 *   threads: () => Readonly<Record<string, Entry>>,
 * }} PendingReads
 */

/**
 * The pending reads of a store: one per list in LISTS; and for apps and threads, one entity by id and the whole
 * collection.
 * @param {import('./store.mjs').Store} store @returns {PendingReads}
 */
export function pendingReads(store) {
  const reads = /** @type {any} */ ({});
  for (const list of /** @type {PendingList[]} */ (Object.keys(LISTS))) reads[list] = (/** @type {string} */ key) => pendingList(store, list, key);
  reads.item = (/** @type {string} */ threadId, /** @type {string} */ id) => pendingItem(store, threadId, id);
  reads.apps = () => pendingCollection(store, 'apps');
  reads.app = (/** @type {string} */ id) => pendingCollection(store, 'apps')[id];
  reads.thread = (/** @type {string} */ id) => pendingCollection(store, 'threads')[id];
  reads.threads = () => pendingCollection(store, 'threads');
  return /** @type {PendingReads} */ (reads);
}

/**
 * A collection of whole entities as memory will hold it once what is held is released: the published map itself when
 * nothing held touches it, else a copy with each held put or removal applied in order, from the JSON release() will
 * apply. Entities are replaced whole, so none is ever mutated. @param {import('./store.mjs').Store} store
 * @param {PendingCollection} coll @returns {Readonly<Record<string, Entry>>}
 */
function pendingCollection(store, coll) {
  const published = store.state[coll] ?? {};
  if (!store.held) return published;
  const { event, removed } = ENTITIES[coll];
  /** @type {Record<string, Entry> | null} */
  let out = null;
  for (const { held, json } of store.heldLog) {
    if (held.type !== event && !(held.type === 'remove' && held.data?.kind === removed)) continue;
    out ??= { ...published };
    const { type, data } = JSON.parse(json);
    try {
      if (type === event) out[data.id] = data;
      else delete out[data.id];
    } catch {
      // the reducer rejects it the same way (missing data), and the release holds it as rejected (#609): skipped
    }
  }
  return out ?? published;
}

/**
 * One item as memory will hold it once what is held is released, in O(1) (#712b). It reads the view's own entries,
 * which the index keeps exact as held events apply, rather than its frozen copy, which is new after each held event.
 * @param {import('./store.mjs').Store} store @param {string} threadId @param {string} id
 */
function pendingItem(store, threadId, id) {
  const list = pendingList(store, 'items', threadId);
  const view = store.held ? store.views.get(`items:${threadId}`) : null;
  return itemOf(view?.entries ?? list, id);
}

/**
 * One list as memory will hold it once what is held is released: the published array itself when nothing is held,
 * else a copy the caller may keep, whose entries no held event touched are the published objects.
 * @param {import('./store.mjs').Store} store @param {PendingList} list @param {string} key @returns {readonly Entry[]}
 */
function pendingList(store, list, key) {
  const published = store.state[list]?.[key] ?? [];
  if (!store.held) return published;
  const name = `${list}:${key}`;
  let v = store.views.get(name);
  if (!v || v.version !== store.version || v.state !== store.state) {
    v = { version: store.version, state: store.state, seen: 0, entries: [...published], own: new Set(), copy: null, copiedAt: -1 };
    store.views.set(name, v);
  }
  // Held jobs leave heldLog only by release, which records, so a view whose version holds has seen a prefix of it.
  applyHeld(store, v, list, key); // an event the reducer rejects is skipped, as the release holds it (#609)
  // One copy per change, shared by every read until the next held event: readers in a loop don't copy the list each time.
  if (v.copiedAt !== v.seen) {
    v.copy = Object.freeze([...v.entries]);
    v.copiedAt = v.seen;
  }
  return v.copy;
}

/** Applies to a view the held jobs it hasn’t seen. @param {import('./store.mjs').Store} store @param {any} v @param {PendingList} list @param {string} key */
function applyHeld(store, v, list, key) {
  const { events, key: by, added } = LISTS[list];
  for (; v.seen < store.heldLog.length; v.seen++) {
    const { held, json } = store.heldLog[v.seen];
    if (!(/** @type {readonly string[]} */ (events).includes(held.type)) || held.data?.[by] !== key) continue;
    const { type, data } = JSON.parse(json); // what release() will apply, not the caller’s object, which may have changed
    if (type.endsWith('.add')) v.own.add(added(data));
    else {
      // The published entry is never touched: the first held event on it takes a copy.
      const at = positionOf(v.entries, data.id);
      if (at >= 0 && !v.own.has(data.id)) v.entries[at] = structuredClone(v.entries[at]);
      v.own.add(data.id);
    }
    try {
      apply({ [list]: { [key]: v.entries } }, type, data);
    } catch {
      // The release holds this event as rejected (#609), and by the reducer's contract its throw changed nothing, so
      // the view skips it too: what is pending stays what the release will publish.
    }
  }
}
