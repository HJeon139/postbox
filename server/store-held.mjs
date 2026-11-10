// The pending read (#601, designs/508/601-held-view.md): a list as memory will hold it once the emits held behind a commit
// are released. An emit made while a commit is queued or in flight is held, not numbered, applied or broadcast until
// the commit settles (server/store.mjs; storage-design.md §6.3), and every held emit is released onto memory in order,
// whether the commit resolves or fails (store-commit.mjs, store-retry.mjs). The published state (store.state,
// store.items()) is what the page, the stream, the read tools and every other reader see (design.md, “visible to
// anything … only after its sync”; T-31). The pending read is for in-process code whose decision would be wrong on a
// list that held writes have superseded, each call site placed in tests/store-held-guard.test.mjs.
//
// It applies held emits without the commit in front of them, whose events don’t exist until the writer runs its
// builder, so it is exact only while no commit touches the list read. One does: the archive pass’s turn.archive (#305,
// server/work-archive.mjs), placed in the guard beside these readers. While it is in flight, a pending read still shows
// the turn’s entries and activity, with held emits on top; a held work.patch for an entry it moves is dropped at the
// release (designs/305-archive-turns.md, “One pass”). A held turn.archive, which nothing emits, the view applies. A
// pending item has no position yet (B1 assigns n at the release), so no pending reader may depend on one.
//
// A view is kept per list, and per collection, and grows as emits are held: while a commit is stuck in its fsync, a
// streaming reply holds an item.text per chunk and readers run per chunk, so each held event is applied once, not once
// per read. It is
// rebuilt when the state changes (record()), and dropped when nothing is held.

import { itemOf, positionOf } from '../shared/item-index.mjs';
import { apply, patchSession } from '../shared/state.mjs';

/** The lists a pending read covers: the events that change one, the key they name it by, and how an add names its entry. */
const LISTS = /** @type {const} */ ({
  items: {
    events: ['item.add', 'item.patch', 'item.move', 'item.text', 'turn.archive'],
    names: (/** @type {any} */ d) => threadsNamed(d),
    added: (/** @type {any} */ d) => d.item?.id,
  },
  work: { events: ['work.add', 'work.patch', 'turn.archive'], names: (/** @type {any} */ d) => [d?.convId], added: (/** @type {any} */ d) => d.entry?.id },
});
/** The threads an items event names: its own, or for a turn.archive (#305) each archived reply’s. O(replies). @param {any} d */
const threadsNamed = (d) => (Array.isArray(d?.items) ? d.items.map((/** @type {any} */ r) => r?.threadId) : [d?.threadId]);
/**
 * The collections of whole entities a pending read covers, keyed by id: the event that puts one whole (the reducer
 * replaces it), the event that patches one if it has one, and the `remove` kind that deletes it. An app is read back by
 * the turn that shows, updates or retires it.
 */
const ENTITIES = /** @type {const} */ ({
  apps: { event: 'app', removed: 'app', patched: null },
  // A topic the turn or the page may have just opened (#637): startTopic reads it to make one topic per message. Every
  // write of a thread starts from it (#796, server/thread-write.mjs).
  threads: { event: 'thread', removed: 'thread', patched: null },
  // A session just made, or changed, behind a held commit: its writes diff against it, and its turn waits for it to be
  // published (#796's class in sessions, server/session-write.mjs).
  sessions: { event: 'session', removed: 'session', patched: 'session.patch' },
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
 *   session: (id: string) => Entry | undefined,
 * }} PendingReads
 */

/**
 * The pending reads of a store: one per list in LISTS; for apps and threads, one entity by id and the whole
 * collection; and one session by id.
 * @param {import('./store.mjs').Store} store @returns {PendingReads}
 */
export function pendingReads(store) {
  const reads = /** @type {any} */ ({});
  for (const list of /** @type {PendingList[]} */ (Object.keys(LISTS))) reads[list] = (/** @type {string} */ key) => pendingList(store, list, key);
  reads.item = (/** @type {string} */ threadId, /** @type {string} */ id) => pendingItem(store, threadId, id);
  reads.apps = () => pendingCollection(store, 'apps');
  reads.app = (/** @type {string} */ id) => pendingEntity(store, 'apps', id);
  reads.thread = (/** @type {string} */ id) => pendingEntity(store, 'threads', id);
  reads.threads = () => pendingCollection(store, 'threads');
  reads.session = (/** @type {string} */ id) => pendingEntity(store, 'sessions', id);
  return /** @type {PendingReads} */ (reads);
}

/**
 * A collection of whole entities as memory will hold it once what is held is released: the published map itself when
 * nothing held touches it, else a frozen copy with each held put, patch or removal applied in order, from the JSON
 * release() will apply, shared by every read until the next held event that touches it. @param {import('./store.mjs').Store} store
 * @param {PendingCollection} coll @returns {Readonly<Record<string, Entry>>}
 */
function pendingCollection(store, coll) {
  const published = store.state[coll] ?? {};
  if (!store.held) return published;
  const v = collectionView(store, coll);
  if (!v.entries) return published;
  if (v.copiedAt !== v.changes) {
    v.copy = Object.freeze({ ...v.entries });
    v.copiedAt = v.changes;
  }
  return v.copy;
}

/** One entity of a collection as memory will hold it once what is held is released, with no copy of the collection. @param {import('./store.mjs').Store} store @param {PendingCollection} coll @param {string} id */
function pendingEntity(store, coll, id) {
  if (!store.held) return store.state[coll]?.[id];
  const v = collectionView(store, coll);
  return (v.entries ?? store.state[coll])?.[id];
}

/**
 * A collection's view, as a list's is kept (pendingList): each held event is applied once, not once per read, so a
 * session written per streamed chunk behind a stuck fsync costs each write the new events, not all of them. Entities
 * are replaced whole, and a patch makes a new one as the reducer's does, so none is ever mutated.
 * @param {import('./store.mjs').Store} store @param {PendingCollection} coll
 */
function collectionView(store, coll) {
  const name = `entities:${coll}`;
  let v = store.views.get(name);
  if (!v || v.version !== store.version || v.state !== store.state) {
    v = { version: store.version, state: store.state, seen: 0, entries: null, changes: 0, copy: null, copiedAt: -1 };
    store.views.set(name, v);
  }
  const { event, removed, patched } = ENTITIES[coll];
  for (; v.seen < store.heldLog.length; v.seen++) {
    const { held, json } = store.heldLog[v.seen];
    if (held.type !== event && held.type !== patched && !(held.type === 'remove' && held.data?.kind === removed)) continue;
    v.entries ??= { ...(store.state[coll] ?? {}) };
    v.changes++;
    const { type, data } = JSON.parse(json);
    try {
      if (type === event) v.entries[data.id] = data;
      // As the reducer applies it: a patch for a session that's gone changes nothing.
      else if (type === patched) {
        if (v.entries[data.id]) v.entries[data.id] = patchSession(v.entries[data.id], data);
      } else delete v.entries[data.id];
    } catch {
      // the reducer rejects it the same way (missing data), and the release holds it as rejected (#609): skipped
    }
  }
  return v;
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
  const { events, names } = LISTS[list];
  for (; v.seen < store.heldLog.length; v.seen++) {
    const { held, json } = store.heldLog[v.seen];
    if (!(/** @type {readonly string[]} */ (events).includes(held.type)) || !names(held.data).includes(key)) continue;
    const { type, data } = JSON.parse(json); // what release() will apply, not the caller’s object, which may have changed
    ownEntries(v, list, key, type, data);
    // Every list there, empty but this one’s view: turn.archive reads both work and items.
    const lists = { items: {}, work: {}, [list]: { [key]: v.entries } };
    try {
      apply(lists, type, data);
      // Read back: turn.archive gives the conversation a new work array rather than changing the old one (#305).
      v.entries = lists[list][key];
    } catch {
      // The release holds this event as rejected (#609), and by the reducer's contract its throw changed nothing, so
      // the view skips it too: what is pending stays what the release will publish.
    }
  }
}

/**
 * Makes the view own the entries a held event changes in place, so the published ones are never touched: the first
 * held event on an entry takes a copy. An add owns its new entry. turn.archive changes its replies’ activity in place,
 * and none of the work entries, whose array it replaces. O(entries named).
 * @param {any} v @param {PendingList} list @param {string} key @param {string} type @param {any} data
 */
function ownEntries(v, list, key, type, data) {
  if (type.endsWith('.add')) {
    v.own.add(LISTS[list].added(data));
    return;
  }
  for (const id of changedIds(list, key, type, data)) {
    const at = positionOf(v.entries, id);
    if (at >= 0 && !v.own.has(id)) v.entries[at] = structuredClone(v.entries[at]);
    v.own.add(id);
  }
}

/** The ids of the entries of the list a held event changes in place. @param {PendingList} list @param {string} key @param {string} type @param {any} data */
function changedIds(list, key, type, data) {
  if (type !== 'turn.archive') return [data.id];
  if (list === 'work') return [];
  return (data.items ?? []).filter((/** @type {any} */ r) => r?.threadId === key).map((/** @type {any} */ r) => r.id);
}
