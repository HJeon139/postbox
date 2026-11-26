// Delivery (designs/architecture/services.md, “Delivery and Turns, built as the inbox”): each agent’s inbox in each
// conversation, as stored entries. An entry is one message for one agent, stored when the message it comes from is
// final (designs/rooms-at-scale.md, “What an entry is”). Nothing is held, merged or dropped: a newer post from the same
// sender is noted on a waiting entry (“posted since”), and only the person’s Stop and delete end one unread.
//
// Its invariants:
// - a send with a retry id already stored makes no second entry (#1138); one entry per final item and recipient is
//   its senders’ rule, such as the item.final listener’s, not something send can check;
// - a take is stored when the turn starts, so a restart knows what the turn held, and a lost turn’s entries reopen
//   once, as a resend (#466);
// - entry.waiting is raised only for an agent that can start a turn now: not busy in Running, its session not failed,
//   not held at the chain cap, and with a waiting entry that isn’t a notice.
//
// Depends on Store, Bus and Running. Until Turns is a service, the composition root listens to entry.waiting and starts
// the turn through today’s deliver, and the chain cap is a predicate the root binds (`chainHeld`).

import { newId } from './store.mjs';
import { arrival, plainMessage } from './turn-batch.mjs';

/** Where an entry comes from (designs/rooms-at-scale.md, “What an entry is”). A notice never starts a turn. */
export const SOURCES = Object.freeze(['mention', 'person', 'command', 'review', 'answer', 'event', 'check', 'scheduled', 'notice']);

/**
 * Sources that are the person’s own action, an app’s event included, since it’s their click: one starts a failed
 * agent’s turn, as it did before entries.
 */
const PERSON = new Set(['person', 'answer', 'command', 'event']);

/**
 * Whether an agent is out of quota now: a failed turn recorded it (turn-quota.mjs), and the reset the harness gave, if
 * any, is still ahead (#442). @param {{ quota?: { until: number | null } | null }} se
 */
const outOfQuota = (se) => Boolean(se.quota) && (se.quota?.until == null || se.quota.until > Date.now());

/**
 * An entry given to a turn of its own until Turns builds input from entries (step 3’s PR 4): one that carries a message
 * other than a plain one, such as an answer’s event or a lint turn, whose kind its turn keeps; and an app’s event.
 * @param {{ source?: string, message?: any }} e
 */
export const alone = (e) => e.source === 'event' || (Boolean(e.message) && !plainMessage(e.message));

/** @typedef {'waiting'|'taken'|'delivered'|'failed'|'stopped'} EntryState */
/**
 * An entry as stored, in the shape server/turn-input.mjs reads: `itemId` or `text`, never both; `from` the sender’s
 * handle without its @, or “you” for the person, and absent for Postbox. `takenBy` is the turn that took it, and
 * `retryId` what a retried send carries (#1138). `woken`, on an entry the person’s Retry reopened, is whom its failed
 * turn’s reply already handed work to, so the turn that takes it doesn’t again (#485). `bounce`, on a mention, is a reply
 * that went back on its own to the agent that woke its writer (reply-back.mjs): a turn only such replies woke may end
 * quietly (#1543, empty-reply.mjs). `backByName`, on a mention, is a reply in words alone that named the agent, from a
 * turn only that agent’s messages woke (mention-entries.mjs): with a bounce, what a reaction can end an exchange on. `message` is what today’s deliver is given for a review, until Turns
 * builds a turn’s input from entries (step 3).
 * @typedef {{ id: string, sessionId: string, threadId: string, source: string, itemId?: string, text?: string,
 *   message?: any, from?: string, at: number, seq: number, state: EntryState, takenBy: string|null, resend: boolean,
 *   postedSince: string[], retryId?: string, woken?: string[], bounce?: boolean, backByName?: boolean, answers?: boolean }} Entry
 */

export class Delivery {
  /**
   * @param {{ store: import('./store.mjs').Store, bus: import('./bus.mjs').Bus, running: import('./running.mjs').Running,
   *   chainHeld: (entry: Entry) => boolean, sizeOf: (entry: Entry) => number }} deps
   *   chainHeld: whether the chain cap holds an entry back; sizeOf: the characters an entry takes of a turn’s budget
   */
  constructor({ store, bus, running, chainHeld, sizeOf }) {
    this.store = store;
    this.bus = bus;
    this.running = running;
    this.chainHeld = chainHeld;
    this.sizeOf = sizeOf;
    /** @type {Map<string, Set<string>>} the person’s entries each failed agent holds for the person (failedWith) */
    this.heldByFailure = new Map();
    /** @type {Map<string, any>} what an entry carries in memory only, by its id (send’s `carry`) */
    this.carried = new Map();
    /** @type {((sessionId: string) => boolean) | null} whether a run clock holds the agent, once run clocks are on (server/run-clock-install.mjs) */
    this.clockHeld = null;
  }

  /**
   * Stores one entry for one agent, and raises entry.waiting if the agent can start a turn from it. An entry with an
   * item keeps no copy of its text; one without keeps its own text (a check’s findings, an event, a notice). Until Turns
   * builds a turn’s input from entries, `message` is what today’s deliver is given for it.
   * `wake: false` stores it without raising entry.waiting: the end of the turn that wrote its item raises it, once that
   * turn has written what its failed reply says (designs/architecture/services.md, “The end of a turn”).
   * `at` is when it arrived, now unless it waited somewhere first, as a stored queue’s row did (#1423).
   * @param {{ sessionId: string, threadId: string, source: string, itemId?: string, text?: string, message?: any,
   *   from?: string, retryId?: string, at?: number, bounce?: boolean, backByName?: boolean, answers?: boolean }} e  `bounce`: a reply going back (Entry)
   * `carry` is a message kept in memory for the turn that takes the entry, and never stored: what an app sent, which
   * stays out of the public inbox (#1425). A restart loses it, as it lost a message held for a busy agent before.
   * @param {{ wake?: boolean, carry?: any }} [opts]
   * @returns {Entry}
   */
  send(e, { wake = true, carry = undefined } = {}) {
    const { sessionId, threadId, source, itemId, text, message, from, retryId, at, bounce = false, backByName = false, answers = false } = e;
    if (!SOURCES.includes(source)) throw new Error(`An entry’s source is one of ${SOURCES.join(', ')}, not “${source}”.`);
    if ((itemId === undefined) === (text === undefined)) throw new Error('An entry has an item or its own text, and not both.');
    const se = this.store.pending.session(sessionId);
    if (!se) throw new Error('That agent’s session doesn’t exist any more, so nothing can be sent to it.');
    if (se.retiredFork) throw new Error(`@${se.handle}’s session was retired, so nothing can be sent to it.`);
    const stored = retryId ? this.inbox(sessionId).find((x) => x.retryId === retryId) : undefined;
    if (stored) return stored;
    /** @type {Entry} */
    const entry = {
      id: newId('en'),
      sessionId,
      threadId,
      source,
      ...(itemId === undefined ? { text } : { itemId }),
      ...(message === undefined ? {} : { message }),
      ...(from === undefined ? {} : { from }),
      at: at ?? Date.now(),
      // Its place among what arrived in the same millisecond, here and with the queue’s messages (#733).
      seq: arrival(),
      state: 'waiting',
      takenBy: null,
      resend: false,
      postedSince: [],
      ...(retryId === undefined ? {} : { retryId }),
      ...(bounce ? { bounce: true } : {}),
      ...(backByName ? { backByName: true } : {}),
      ...(answers ? { answers: true } : {}),
    };
    this.store.emit('entry.add', { sessionId, entry });
    if (carry !== undefined) this.carried.set(entry.id, carry);
    if (wake) this.wake(sessionId);
    return entry;
  }

  /**
   * Every session that may have entries, read pending as its writes are, so an inbox whose first entry is held behind a
   * commit is in it (#796’s class): a session’s entries go with it, so it has none without a session.
   */
  sessionIds() {
    return Object.keys(this.store.pending.sessions());
  }

  /** The agent’s entries, as memory will hold them once what is held is released. @param {string} sessionId */
  inbox(sessionId) {
    return this.store.pending.inbox(sessionId);
  }

  /** The agent’s waiting entries, oldest first. @param {string} sessionId */
  waiting(sessionId) {
    return this.inbox(sessionId).filter((e) => e.state === 'waiting');
  }

  /** Every entry made from an item, in any inbox. @param {string} itemId */
  entriesFrom(itemId) {
    return this.sessionIds().flatMap((sessionId) => this.inbox(sessionId).filter((e) => e.itemId === itemId));
  }

  /**
   * Whether the agent can start a turn from its entries now: free in Running, its session there and not failed, its run
   * clock, with run clocks on, not holding it (paused or expired), and with a waiting entry that isn’t a notice and
   * isn’t held at the chain cap.
   * @param {string} sessionId
   */
  ready(sessionId) {
    if (this.running.busy(sessionId) || this.running.closing) return false;
    const se = this.store.pending.session(sessionId);
    if (!se || se.retiredFork || this.clockHeld?.(sessionId)) return false;
    return this.waiting(sessionId).some((e) => this.canStart(e, se));
  }

  /**
   * Whether an entry can start a turn: not a notice, not held at the chain cap, and, for a failed agent, the person’s
   * own action or its own scheduled wake, since anything else waits for the person; not their messages that were
   * waiting when its turn failed, though (failedWith). Out of quota, the person’s own action alone (#442).
   * @param {Entry} e @param {{ id?: string, state?: string, quota?: { until: number | null } | null }} se  the agent’s session
   */
  canStart(e, se) {
    if (e.source === 'notice' || this.chainHeld(e)) return false;
    // Out of quota, only the person’s own action tries again before the reset (#442): anything else would fail the same way.
    if (outOfQuota(se) && !PERSON.has(e.source)) return false;
    if (se.state !== 'failed') return true;
    // A scheduled wake is the agent’s own, which started a failed agent’s turn before entries, as its retries rely on (#466).
    if (e.source === 'scheduled') return true;
    return PERSON.has(e.source) && !this.heldByFailure.get(e.sessionId)?.has(e.id);
  }

  /**
   * The agent’s turn failed: the person’s messages waiting for it wait for the person to act (Retry, or a new message),
   * as their queued messages did when a failed turn’s end drained only agents’ wakes (#1146). Kept in memory, as that
   * rule was: a restart, or a host turn’s attach given up, sends what waited, as the queue’s drain did (#1135).
   * @param {string} sessionId
   */
  failedWith(sessionId) {
    const ids = this.waiting(sessionId)
      .filter((e) => e.source === 'person')
      .map((e) => e.id);
    if (ids.length) this.heldByFailure.set(sessionId, new Set(ids));
  }

  /** Raises entry.waiting for the agent, if it can start a turn now. @param {string} sessionId */
  wake(sessionId) {
    if (this.ready(sessionId)) this.bus.emit('entry.waiting', { sessionId });
  }

  /**
   * A turn starts and takes the waiting entries of one thread, that of the oldest waiting entry that can start one, with
   * the notices waiting to ride it, in order, up to `budget` characters (designs/rooms-at-scale.md, “The budget”). That
   * oldest entry, the lead, is always taken: one larger than the budget still reaches a turn, and a notice before it
   * can’t crowd it out. The rest wait for the next turn, so nothing is dropped. Each taken entry records the turn.
   * `threadId` names the thread when the turn already has one: one the queue started for the person’s message there
   * takes that thread’s entries with it.
   * @param {string} sessionId @param {string} turnId @param {number} [budget] @param {string} [threadId]
   * @returns {Entry[]}
   */
  take(sessionId, turnId, budget = Number.POSITIVE_INFINITY, threadId = undefined) {
    const waiting = this.waiting(sessionId).filter((e) => threadId === undefined || e.threadId === threadId || e.source === 'notice');
    const se = this.store.pending.session(sessionId) ?? {};
    const lead = waiting.find((e) => this.canStart(e, se)) ?? waiting.find((e) => e.source !== 'notice');
    if (!lead) return [];
    if (alone(lead)) {
      // A turn that already has its message (threadId) takes none: this one waits for a turn of its own.
      if (threadId !== undefined) return [];
      this.patch(lead, { state: 'taken', takenBy: turnId });
      return [{ ...lead, state: /** @type {EntryState} */ ('taken'), takenBy: turnId }];
    }
    // The lead first, whatever its size, so nothing that arrived before it uses the budget up; then the rest in order,
    // until one doesn’t fit. They’re taken, and given, in the order they arrived.
    const chosen = new Set([lead]);
    let size = this.sizeOf(lead);
    for (const e of waiting) {
      if (e === lead || !(e.source === 'notice' || (e.threadId === lead.threadId && !this.chainHeld(e)))) continue;
      // One for a turn of its own waits, with what came after it, so the order holds.
      if (alone(e)) break;
      const n = this.sizeOf(e);
      if (size + n > budget) break;
      chosen.add(e);
      size += n;
    }
    const taken = waiting.filter((e) => chosen.has(e));
    for (const e of taken) this.patch(e, { state: 'taken', takenBy: turnId });
    return taken.map((e) => ({ ...e, state: /** @type {EntryState} */ ('taken'), takenBy: turnId }));
  }

  /**
   * A newer post from a sender in a thread: noted on each of its waiting entries there (“@x posted since”), never put
   * in their place. A later part of the same turn’s reply is the same post, not a newer one (#374).
   * @param {{ threadId: string, from: string, itemId: string, turnId?: string }} post
   */
  postedSince({ threadId, from, itemId, turnId }) {
    const sameTurn = (/** @type {Entry} */ e) => {
      const it = turnId && e.itemId ? this.store.pending.item(e.threadId, e.itemId) : null;
      return Boolean(it) && (it.turnId === turnId || it.fromTurnId === turnId);
    };
    for (const sessionId of this.sessionIds())
      for (const e of this.waiting(sessionId))
        if (e.threadId === threadId && e.from === from && e.itemId !== itemId && !e.postedSince.includes(itemId) && !sameTurn(e))
          this.patch(e, { postedSince: [...e.postedSince, itemId] });
  }

  /**
   * A turn ended, well or stopped: what it took was delivered, and the agent’s next turn starts if entries are left.
   * @param {{ sessionId: string, turnId: string }} turn
   */
  turnEnded({ sessionId, turnId }) {
    this.heldByFailure.delete(sessionId);
    for (const e of this.takenBy(sessionId, turnId)) this.patch(e, { state: 'delivered' });
    this.wake(sessionId);
  }

  /**
   * A turn failed. Lost after the harness accepted it, and not a resend, its entries go back to waiting as a resend,
   * and start the one resend on their own (#466); lost again, they fail. Any other failure delivered them: the agent was
   * given them, and the failed session waits for the person. Either way the person can Retry it, which reopens them,
   * so what they carry in memory stays until a turn delivers them for good, or their agent is removed.
   * @param {{ sessionId: string, turnId: string, lost: boolean }} turn
   */
  turnFailed({ sessionId, turnId, lost }) {
    for (const e of this.takenBy(sessionId, turnId)) {
      if (!lost) this.patch(e, { state: 'delivered' }, { keepCarry: true });
      else if (e.resend) this.patch(e, { state: 'failed' }, { keepCarry: true });
      else this.patch(e, { state: 'waiting', takenBy: null, resend: true });
    }
    this.wake(sessionId);
  }

  /**
   * The person’s Retry of a failed turn: what it took waits again, as a resend, for the turn Turns starts from it
   * (#1429), marked with whom the failed reply already woke (`woken`).
   * @param {string} turnId @param {string[]} woken @returns {Entry[]} the entries reopened
   */
  retry(turnId, woken) {
    const reopened = [];
    for (const sessionId of this.sessionIds())
      for (const e of this.inbox(sessionId))
        if (e.takenBy === turnId) {
          const entry = { ...e, state: /** @type {EntryState} */ ('waiting'), takenBy: null, resend: true, woken };
          // Whole: it was delivered, so a page has dropped it, and a patch would reach nothing there.
          this.store.emit('entry.put', { sessionId, id: e.id, entry });
          reopened.push(entry);
        }
    return reopened;
  }

  /**
   * The person removed one waiting entry from the agent’s queue: it’s stopped, so no turn starts from it, and the
   * sender can see it. Returns it, or null when it isn’t waiting there any more.
   * @param {string} sessionId @param {string} entryId @returns {Entry|null}
   */
  cancel(sessionId, entryId) {
    const e = this.waiting(sessionId).find((x) => x.id === entryId);
    if (!e) return null;
    this.patch(e, { state: 'stopped' });
    return e;
  }

  /**
   * The person’s Send now on one waiting entry: a turn takes it alone, ahead of the rest. Returns it, or null when it
   * isn’t waiting there any more. @param {string} sessionId @param {string} entryId @param {string} turnId
   * @returns {Entry|null}
   */
  takeOne(sessionId, entryId, turnId) {
    const e = this.waiting(sessionId).find((x) => x.id === entryId);
    if (!e) return null;
    this.patch(e, { state: 'taken', takenBy: turnId });
    return { ...e, state: 'taken', takenBy: turnId };
  }

  /**
   * The person stopped the agent: its waiting entries are stopped, so none starts a turn, and the sender can see it.
   * The person’s messages keep waiting, as their queued messages did across a Stop (#1040), unless the agent was
   * removed (`all`).
   * @param {string} sessionId @param {{ all?: boolean }} [opts] @returns {Entry[]} the entries stopped
   */
  stopped(sessionId, { all = false } = {}) {
    const stopped = this.waiting(sessionId).filter((e) => all || e.source !== 'person');
    for (const e of stopped) this.patch(e, { state: 'stopped' });
    // A removed agent’s failed turn can’t be retried: what its entries kept for a Retry goes (turnFailed).
    if (all) for (const e of this.inbox(sessionId)) this.carried.delete(e.id);
    return stopped;
  }

  /**
   * Postbox started. An entry taken by a turn that has no record of ending reopens once, as a resend, and one a resend
   * took fails; one a host turn took stays with it while the turn waits to be attached. Then every agent that can
   * start a turn from its entries is woken. Runs after the host turns are restored, so Running knows which wait.
   */
  start() {
    for (const sessionId of this.sessionIds()) {
      if (this.running.awaitsAttach(sessionId)) continue;
      for (const e of this.inbox(sessionId))
        if (e.state === 'taken') this.patch(e, e.resend ? { state: 'failed' } : { state: 'waiting', takenBy: null, resend: true });
    }
    for (const sessionId of this.sessionIds()) this.wake(sessionId);
  }

  /** The agent’s entries a turn took. @param {string} sessionId @param {string} turnId */
  takenBy(sessionId, turnId) {
    return this.inbox(sessionId).filter((e) => e.state === 'taken' && e.takenBy === turnId);
  }

  /** What an entry carries in memory, if it still does (send’s `carry`). @param {string} entryId */
  carriedFor(entryId) {
    return this.carried.get(entryId);
  }

  /**
   * Writes fields of one entry. One that leaves waiting and taken for good, whichever way (delivered, failed, stopped),
   * lets go of what it carried in memory (send’s `carry`), unless a Retry can still reopen it (`keepCarry`).
   * @param {Entry} e @param {Partial<Entry>} patch @param {{ keepCarry?: boolean }} [opts]
   */
  patch(e, patch, { keepCarry = false } = {}) {
    if (!keepCarry && patch.state && patch.state !== 'waiting' && patch.state !== 'taken') this.carried.delete(e.id);
    this.store.emit('entry.patch', { sessionId: e.sessionId, id: e.id, patch });
  }
}
