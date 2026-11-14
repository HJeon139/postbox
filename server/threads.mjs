// Conversations, topic and side threads, their items, and who has one open (designs/architecture/services.md,
// “Threads”). Threads is a service: Runtime’s constructor builds it with the store and the bus, and nothing else writes a
// thread or an item but through it. Its invariants: an item has one live copy (bringForward leaves a stub where it
// was); a topic’s reply count follows each message; a thread’s lineage ends at its conversation. Where it used to call
// into another concern, it signals on the bus: item.added (a side thread’s line counts the message) and item.moved
// (the readers’ markers move to the stub). Until Sessions is a service, the facade’s createThread and view() do their
// part.
//
// The one write of a thread that already exists (#796): it starts from the thread as memory will hold it once what is
// held behind a commit is released (store.pending.thread), never from the published one. A write built from the
// published thread overwrote a write of the same thread still held: a queued wake was lost, and the wake limit stopped
// counting (designs/508/601-held-view.md, “a read that decides a write reads pending”). The thread is put whole, as
// the `thread` event has always carried it, so the reducer, A2’s conversion and the page see no new shape.
// tests/thread-write-guard.test.mjs places every thread write, so a new one goes through here.

import { carriedList } from '../shared/work.mjs';
import { httpError } from './helpers.mjs';
import { toggleReaction } from './reactions.mjs';
import { newId } from './store.mjs';

/** How long a thread counts as open after the page last said so. */
const VIEWING_MS = 20000;

export class Threads {
  /** @param {{ store: import('./store.mjs').Store, bus: import('./bus.mjs').Bus }} deps */
  constructor({ store, bus }) {
    this.store = store;
    this.bus = bus;
    /** @type {Map<string, number>} threadId → the last time a browser said it was open */
    this.viewing = new Map();
  }

  // ── Threads ────────────────────────────────────────────────────────────────────────

  /** A thread, or a 404 when it doesn’t exist. @param {string} id */
  get(id) {
    const t = this.store.state.threads[id];
    if (!t) throw httpError(404, 'That thread doesn’t exist. It may have been deleted.');
    return t;
  }

  /**
   * Starts a conversation in a project, with no agents yet: the facade’s createThread gives each its session.
   * @param {{ projectId: string, title: string, kind?: string, parentId?: string|null }} opts
   */
  create({ projectId, title, kind = 'thread', parentId = null }) {
    if (!this.store.state.projects[projectId]) throw httpError(404, 'That project doesn’t exist.');
    return this.put({
      id: newId('th'),
      projectId,
      title: title || 'New conversation',
      kind,
      parentId,
      members: [],
      lastSpeaker: null,
      hops: 0,
      queue: [],
      createdAt: Date.now(),
    });
  }

  /** Writes a new thread as given: a conversation, or a topic or side thread. @param {any} t */
  put(t) {
    this.store.emit('thread', { ...t });
    return t;
  }

  /**
   * Writes one thread: its pending state with `change` applied. `change` is the fields to set, or a function of the
   * pending thread that returns them, or null to write nothing, so a field read to decide the write is read pending
   * too. A thread that doesn’t exist, published or held, isn’t written. Returns the thread as written, or undefined.
   * @param {string} id @param {Record<string, unknown> | ((t: any) => Record<string, unknown> | null)} change
   */
  patch(id, change) {
    const t = this.store.pending.thread(id);
    if (!t) return undefined;
    const patch = typeof change === 'function' ? change(t) : change;
    if (!patch) return undefined;
    const next = { ...t, ...patch };
    this.store.emit('thread', next);
    return next;
  }

  /**
   * The thread a write is about to change, as memory will hold it, or a 404 when it doesn’t exist there: one just started
   * behind a held commit isn’t published yet, and one just deleted still is (#796’s class). A route that sends what the
   * write returns then answers with the thread, or this refusal, never with nothing.
   * @param {string} id
   */
  toWrite(id) {
    const t = this.store.pending.thread(id);
    if (!t) throw httpError(404, 'That thread doesn’t exist. It may have been deleted.');
    return t;
  }

  /** Every thread, as memory will hold them once what is held is released: for a sweep whose finds decide writes. */
  pending() {
    return Object.values(this.store.pending.threads());
  }

  /** Names a thread, as an agent’s title or the person’s edit does. @param {string} id @param {unknown} title */
  rename(id, title) {
    this.toWrite(id);
    const name = String(title ?? '')
      .trim()
      .slice(0, 120);
    if (!name) throw httpError(422, 'A conversation needs a name.');
    return this.patch(id, { title: name });
  }

  // ── Items ──────────────────────────────────────────────────────────────────────────

  /** Adds an item to a thread and returns it, with an id and a time unless it has them. @param {string} threadId @param {any} item */
  addItem(threadId, item) {
    const it = { id: item.id ?? newId('it'), at: Date.now(), ...item };
    this.store.emit('item.add', { threadId, item: it });
    // A reply in a topic thread counts on the message it branched from, as “3 replies”: one maybe just opened, held (#796).
    const t = this.store.pending.thread(threadId);
    if (t?.kind === 'topic' && (it.kind === 'user' || it.kind === 'agent')) {
      const replies = this.store.pending.items(threadId).filter((x) => x.kind === 'user' || x.kind === 'agent').length;
      this.patchItem(t.parentId, t.rootItemId, { replies, lastReplyAt: it.at });
    }
    this.bus.emit('item.added', { threadId, item: it, thread: t });
    return it;
  }

  /** @param {string} threadId @param {string} id @param {Record<string, any>} patch */
  patchItem(threadId, id, patch) {
    this.store.emit('item.patch', { threadId, id, patch });
  }

  /**
   * Brings an item to the newest point in its thread (#49, #92), for an update the person has to see: an app’s new
   * version, or a block that asks again. The agent explains the change in its newest message, so the item belongs
   * beside it. The item keeps its id, so there’s only ever one live copy, and a one-line stub takes its old place and
   * leads to it. An item that’s already the newest just takes the patch.
   * @param {string} threadId @param {string} id
   * @param {{ what: 'app'|'block', title: string, v?: number }} stub  what the stub says moved
   * @param {Record<string, any>} [patch]  set on the item as it moves
   * @returns {boolean} whether it moved
   */
  bringForward(threadId, id, stub, patch = {}) {
    const items = this.store.pending.items(threadId);
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    if (i === items.length - 1) {
      if (Object.keys(patch).length) this.patchItem(threadId, id, patch);
      return false;
    }
    const now = Date.now();
    const st = { id: newId('it'), kind: 'moved', at: now, itemId: id, ...stub, ...carriedList(items[i]).stub };
    this.store.emit('item.move', { threadId, id, stub: st, patch: { ...patch, ...carriedList(items[i]).item, at: now, movedAt: now } });
    this.bus.emit('item.moved', { threadId, id, stubId: st.id });
    return true;
  }

  // ── A thread’s place in its conversation (#101, #110, #121) ─────────────────────────

  /**
   * A thread, then the conversation it branched from, following parentId (a topic or side thread’s is one level), as
   * `thread` reads one. @param {string} threadId @param {(id: string) => any} [thread]
   */
  lineage(threadId, thread = (id) => this.store.state.threads[id]) {
    const out = [];
    for (let id = threadId; id && thread(id) && !out.includes(id) && out.length < 8; id = thread(id).parentId) out.push(id);
    return out;
  }

  /**
   * Every thread of a thread’s conversation: its lineage first, then the conversation’s other side and topic threads.
   * What read_conversation { thread } and read_message may read.
   * @param {string} threadId
   */
  conversationThreads(threadId) {
    const own = this.lineage(threadId);
    const root = own.at(-1);
    const rest = Object.values(this.store.state.threads)
      .filter((t) => !own.includes(t.id) && this.lineage(t.id).at(-1) === root)
      .map((t) => t.id);
    return [...own, ...rest];
  }

  /**
   * The terms a thread knows: its own glossary over its parent’s, so a topic thread inherits its conversation’s
   * terms and its own definition wins. The browser’s glossaryOf (app/js/thread.mjs) merges the same way.
   * @param {string} threadId
   */
  glossaryFor(threadId) {
    return Object.assign(
      {},
      ...this.lineage(threadId)
        .map((id) => this.store.state.glossary[id] ?? {})
        .reverse(),
    );
  }

  // ── Notifications, presence and reactions ──────────────────────────────────────────

  /**
   * A notification for the person. threadId: where it happened, when that isn’t the session’s own thread (a turn in a
   * side thread, #110). @param {string} level @param {any} se @param {string} title @param {string} text @param {string|null} [threadId]
   */
  notify(level, se, title, text, threadId = null) {
    this.store.emit('notify', { level, sessionId: se.id, threadId: threadId ?? se.threadId, handle: se.handle, title, text });
  }

  /**
   * A browser has the thread open: it counts as viewed for a while, and its unread count clears, read pending as the
   * thread’s next write (#796). The sessions’ unread counts are Sessions’, cleared by the facade’s view().
   * @param {string} threadId
   */
  view(threadId) {
    if (!threadId) return;
    this.viewing.set(threadId, Date.now());
    this.patch(threadId, (t) => (t.unread ? { unread: 0 } : null));
  }

  /** Whether a browser had the thread open in the last 20 seconds. @param {string} threadId */
  isViewing(threadId) {
    return Date.now() - (this.viewing.get(threadId) ?? 0) < VIEWING_MS;
  }

  /**
   * Adds a reaction to an item, or takes back this reactor’s (server/reactions.mjs, #251).
   * @param {string} threadId @param {string} itemId @param {unknown} emoji @param {{ id: string, handle: string } | null} [by]
   */
  toggleReaction(threadId, itemId, emoji, by = null) {
    return toggleReaction(this.store, threadId, itemId, emoji, by);
  }
}
