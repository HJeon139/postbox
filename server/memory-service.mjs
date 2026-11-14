// Memory (designs/architecture/services.md, “Memory”): what an agent reads of its conversation. Every agent in a
// conversation can read all of it. Each session keeps a marker of the last item it was given; a turn starts with what
// came after it, from the person and the other agents (catch-up.mjs), or, in a topic or side thread, with what was said
// there since the agent last took part (thread-catch-up.mjs), and read_conversation and read_message read further back
// (read-message.mjs). An item reads as one line (item-lines.mjs). Memory is a service: Runtime’s constructor builds it
// with the store, Threads, Sessions, Personas, Placement, Assets and Apps, and the `catchUpLines` port, and its modules
// take it, never the runtime. What waits for the person and is meant for an agent comes into its catch-up only through
// `catchUpLines`. The thread summaries are a service of their own (summary-service.mjs).

import { READING } from '../shared/limits.mjs';
import { catchUp, moveMarkers, pointerIfSeen } from './catch-up.mjs';
import { describeItem, topicRootLine } from './item-lines.mjs';
import { readConversation, readLine, readMessage } from './read-message.mjs';
import { threadCatchUp, turnContext } from './thread-catch-up.mjs';

export class Memory {
  /**
   * @param {{ store: import('./store.mjs').Store, threads: import('./threads.mjs').Threads,
   *           sessions: { update: (id: string, change: any) => void, pendingIn: (threadId: string) => any[] },
   *           personas: { forSession: (se: any) => any }, placement: { hostOf: (persona: any) => any },
   *           assets: { attachmentPath: (threadId: string, a: any) => string|null }, apps: { appOf: (item: any) => any },
   *           catchUpLines: (se: any) => string[] }} deps
   *   catchUpLines: the lines code that waits for rooms at scale adds to an agent’s catch-up (the port;
   *   designs/architecture/services.md, “The services”): the messages held for it on a card waiting for the person (#693).
   */
  constructor({ store, threads, sessions, personas, placement, assets, apps, catchUpLines }) {
    this.store = store;
    this.threads = threads;
    this.sessions = sessions;
    this.personas = personas;
    this.placement = placement;
    this.assets = assets;
    this.apps = apps;
    this.catchUpLines = catchUpLines;
  }

  // ── A turn’s start ─────────────────────────────────────────────────────────────────

  /**
   * The catch-up text for a session, or null, and moves its marker to the end of the conversation. exclude: the
   * messages the turn delivers, which it reads in full there (#506). @param {any} se @param {string[]} [exclude]
   */
  catchUp(se, exclude = []) {
    return catchUp(this, se, exclude);
  }

  /**
   * What a turn reads before its message: the room’s catch-up, and in a topic or side thread, that thread’s as its task.
   * @param {any} se @param {string} where  the thread the turn speaks in @param {any} message @param {boolean} slash
   */
  turnContext(se, where, message, slash) {
    return turnContext(this, se, where, message, slash);
  }

  /** What a turn in a topic or side thread catches up on there, or null. @param {any} se @param {string} threadId @param {string[]} [exclude] */
  threadCatchUp(se, threadId, exclude = []) {
    return threadCatchUp(this, se, threadId, exclude);
  }

  /** A mention the last catch-up gave the agent comes as a pointer to it (#484). @param {any} se @param {any} message */
  pointerIfSeen(se, message) {
    return pointerIfSeen(this, se, message);
  }

  /** An item moved to the end of its thread: a marker on it moves to its stub (#1041). @param {string} threadId @param {string} id @param {string} stubId */
  moveMarkers(threadId, id, stubId) {
    moveMarkers(this, threadId, id, stubId);
  }

  // ── An item as an agent reads it ───────────────────────────────────────────────────

  /**
   * One conversation item as a line an agent can read, from the point of view of `se` (item-lines.mjs).
   * @param {any} i @param {any} [se] @param {number} [n] @param {any} [reader]  the session its attachments are for
   */
  describeItem(i, se = null, n = READING.item, reader = se) {
    return describeItem(this, i, se, n, reader);
  }

  /** The message a topic thread started from, for an agent’s first turn there. @param {any} se @param {any} t */
  topicRootLine(se, t) {
    return topicRootLine(this, se, t);
  }

  // ── The read tools ─────────────────────────────────────────────────────────────────

  /** read_conversation. @param {any} se @param {{ limit?: number, skip?: number, thread?: unknown }} [args] */
  readConversation(se, args) {
    return readConversation(this, se, args);
  }

  /** read_message. @param {any} se @param {{ id?: string, from?: number, version?: number }} [args] */
  readMessage(se, args = {}) {
    return readMessage(this, se, args);
  }

  /** An item as the read tools give it to `se`, its own messages as “You”. @param {any} i @param {any} se @param {number} [n] */
  readLine(i, se, n) {
    return readLine(this, i, se, n);
  }
}
