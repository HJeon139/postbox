// The pending read (#601, designs/508/601-held-view.md): a list as memory will hold it once the emits held behind a commit
// are released. An emit made while a commit is queued or in flight is held, not numbered, applied or broadcast until
// the commit settles (server/store.mjs; storage-design.md §6.3), and every held emit is released onto memory in order,
// whether the commit resolves or fails (store-commit.mjs, store-retry.mjs). The published state (store.state,
// store.items()) is what the page, the stream, the read tools and every other reader see (design.md, “visible to
// anything … only after its sync”; T-31). The pending read is for in-process code whose decision would be wrong on a
// list that held writes have superseded, each call site placed in tests/store-held-sites.mjs.
//
// It applies held emits without the commit in front of them, whose events don’t exist until the writer runs its
// builder, so it is exact only while no commit touches the list read. One does: the archive pass’s turn.archive (#305,
// server/work-archive.mjs), placed in the guard beside these readers. While it is in flight, a pending read still shows
// the turn’s moved entries and full activity, with held emits on top, and a held work.patch for a moved entry is
// dropped at the release (designs/305-archive-turns.md, “One pass”). What the pending readers decide on, the kept
// entries and the newest turns, isn’t moved, so it reads the same before, during and after (T-16). A pending item has
// no position yet (B1 assigns n at the release), so no pending reader may depend on one.
//
// A view is kept per list, and per collection, and grows as emits are held: while a commit is stuck in its fsync, a
// streaming reply holds an item.text per chunk and readers run per chunk, so each held event is applied once, not once
// per read. It is
// rebuilt when the state changes (record()), and dropped when nothing is held.

import { itemOf, positionOf } from '../shared/item-index.mjs';
import { apply, patchSession } from '../shared/state.mjs';
import { Fifo } from './fifo.mjs';

/** The lists a pending read covers: the events that change one, the key they name it by, and how an add names its entry. */
const LISTS = /** @type {const} */ ({
  items: { events: ['item.add', 'item.patch', 'item.move', 'item.text'], key: 'threadId', added: (/** @type {any} */ d) => d.item?.id },
  work: { events: ['work.add', 'work.patch'], key: 'convId', added: (/** @type {any} */ d) => d.entry?.id },
  // An agent's inbox (server/delivery.mjs): its entries are written in the same held write as the item they come from.
  inbox: { events: ['entry.add', 'entry.patch', 'entry.put'], key: 'sessionId', added: (/** @type {any} */ d) => d.entry?.id },
});
/**
 * The collections of whole entities a pending read covers, keyed by id: the event that puts one whole (the reducer
 * replaces it), the event that patches one if it has one, and the `remove` kind that deletes it. An app is read back by
 * the turn that shows, updates or retires it.
 */
const ENTITIES = /** @type {const} */ ({
  apps: { event: 'app', removed: 'app', patched: null },
  // A topic the turn or the page may have just opened (#637): startTopic reads it to make one topic per message. Every
  // write of a thread starts from it (#796, server/threads.mjs).
  threads: { event: 'thread', removed: 'thread', patched: null },
  // A session just made, or changed, behind a held commit: its writes diff against it, and its turn waits for it to be
  // published (#796's class in sessions, server/sessions.mjs).
  sessions: { event: 'session', removed: 'session', patched: 'session.patch' },
  // A persona just made behind a held commit, which a session joining it reads (POST /api/personas with join, and an
  // attached Claude Code session, #1247’s class).
  personas: { event: 'persona', removed: 'persona', patched: null },
  // A project changed behind a held commit, whose folder a `!` command runs in (#1292). Projects are never removed.
  projects: { event: 'project', removed: null, patched: null },
});
/**
 * The names of what a held event touches, as the views are named: each list it changes (`items:<threadId>`) and each
 * collection (`entities:sessions`). @param {any} ev
 */
function touchedBy(ev) {
  const names = [];
  for (const [list, { events, key }] of Object.entries(LISTS))
    if (/** @type {readonly string[]} */ (events).includes(ev.type)) names.push(`${list}:${ev.data?.[key]}`);
  for (const [coll, { event, removed, patched }] of Object.entries(ENTITIES))
    if (ev.type === event || ev.type === patched || (ev.type === 'remove' && ev.data?.kind === removed)) names.push(`entities:${coll}`);
  return names;
}

/**
 * The held emits, in order, with a count of the held events that touch each list and collection: a pending read of
 * one that nothing held touches is the published one, with no view to build. A busy room reads every agent’s inbox
 * while a snapshot holds its writes, and most inboxes have nothing held. The names are taken when a job is held, and
 * kept on it, so its release takes back exactly what it added, whatever its caller does to its object meanwhile.
 * @extends {Fifo<any>}
 */
export class HeldLog extends Fifo {
  /** @type {Map<string, number>} */
  touched = new Map();

  /** @param {any} job */
  push(job) {
    job.touches = touchedBy(job.held);
    for (const name of job.touches) this.touched.set(name, (this.touched.get(name) ?? 0) + 1);
    super.push(job);
  }

  shift() {
    const job = super.shift();
    for (const name of job?.touches ?? []) {
      const n = (this.touched.get(name) ?? 0) - 1;
      if (n > 0) this.touched.set(name, n);
      else this.touched.delete(name);
    }
    return job;
  }
}

/** Whether a held event touches a view’s list or collection. @param {import('./store.mjs').Store} store @param {string} name */
const heldOn = (store, name) => Boolean(store.held) && /** @type {any} */ (store.heldLog).touched?.has(name) !== false;

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
 *   sessions: () => Readonly<Record<string, Entry>>,
 *   persona: (id: string) => Entry | undefined,
 *   project: (id: string) => Entry | undefined,
 *   clock: (sessionId: string) => Entry | null,
 * }} PendingReads
 */

/**
 * The pending reads of a store: one per list in LISTS; for apps and threads, one entity by id and the whole
 * collection; every session, or one by id; and one persona or project by id.
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
  reads.sessions = () => pendingCollection(store, 'sessions');
  reads.persona = (/** @type {string} */ id) => pendingEntity(store, 'personas', id);
  reads.project = (/** @type {string} */ id) => pendingEntity(store, 'projects', id);
  reads.clock = (/** @type {string} */ sessionId) => pendingClock(store, sessionId);
  return /** @type {PendingReads} */ (reads);
}

/**
 * An agent’s run clock as memory will hold it once what is held is released (shared/run-clock.mjs): its held events
 * applied in order to a copy, by the reducer, so a clock started, paused or expired behind a held commit holds and
 * times its agent at once (#1526). Only the run clock’s own code reads it, and only with POSTBOX_RUN_CLOCK=1, so no
 * index of held events names clocks: a read walks what is held. Delivery.ready asks on every wake while a commit is
 * held, so each such wake walks the held log once; that’s fine for a timed UAT room, whose held log is short.
 * @param {import('./store.mjs').Store} store @param {string} sessionId @returns {Entry|null}
 */
function pendingClock(store, sessionId) {
  const published = store.state.clocks && Object.hasOwn(store.state.clocks, sessionId) ? store.state.clocks[sessionId] : null;
  if (!store.held) return published;
  const s = { clocks: Object.assign(Object.create(null), published ? { [sessionId]: { ...published } } : {}) };
  for (let i = 0; i < store.heldLog.length; i++) {
    const { held, json } = store.heldLog.at(i);
    const removes = held.type === 'remove' && held.data?.kind === 'session' && held.data.id === sessionId;
    if (removes) delete s.clocks[sessionId];
    if (removes || !held.type?.startsWith('clock.') || held.data?.sessionId !== sessionId) continue;
    const { type, data } = JSON.parse(json);
    try {
      apply(s, type, data);
    } catch {
      // the reducer rejects it the same way, and the release holds it as rejected (#609): skipped
    }
  }
  return s.clocks[sessionId] ?? null;
}

/**
 * A collection of whole entities as memory will hold it once what is held is released: the published map itself when
 * nothing held touches it, else a frozen copy with each held put, patch or removal applied in order, from the JSON
 * release() will apply, shared by every read until the next held event that touches it. @param {import('./store.mjs').Store} store
 * @param {PendingCollection} coll @returns {Readonly<Record<string, Entry>>}
 */
function pendingCollection(store, coll) {
  const published = store.state[coll] ?? {};
  if (!heldOn(store, `entities:${coll}`)) return published;
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
  if (!heldOn(store, `entities:${coll}`)) return store.state[coll]?.[id];
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
    const { held, json } = store.heldLog.at(v.seen);
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
  const name = `${list}:${key}`;
  if (!heldOn(store, name)) return published;
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
    const { held, json } = store.heldLog.at(v.seen);
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
