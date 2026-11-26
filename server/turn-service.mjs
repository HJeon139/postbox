// Turns (designs/architecture/services.md, “Delivery and Turns, built as the inbox”, Turns): the one way an agent’s
// turn starts. Every start is one of its steps, by what starts it: the agent’s waiting entries (start); the person’s
// Send now on one of them (takeAlone); what waited on a turn, given once it ended or its process exited (release); a
// host turn resumed or attached again after a restart (resume); and the person’s Retry of a failed reply (retry). Each
// goes through run, which builds the turn and hands it to its adapter (server/turn-run.mjs). Built by the composition
// root as `rt.turnService`, since `rt.turns` is Running’s map of live turns; it takes the Runtime until the rest of
// what a turn reads is a service.

import { sendEntryAlone } from './entry-queue.mjs';
import { deliver, retry } from './turn-run.mjs';
import { startFromEntries } from './turns.mjs';

export class Turns {
  /**
   * @param {any} rt
   * @param {{ asks: ReturnType<typeof import('./asks-port.mjs').asksPort> }} ports  `asks`: its one way into waiting code
   *   (server/asks-port.mjs), until Asks
   */
  constructor(rt, { asks }) {
    this.rt = rt;
    this.asks = asks;
    /** The backends whose run-out of quota the person was told of, until a turn of theirs ends well (turn-quota.mjs). */
    this.quotaNoticed = new Set();
  }

  /** The agent’s waiting entries of one thread start its turn (entry.waiting). @param {string} sessionId */
  start(sessionId) {
    startFromEntries(this.rt, sessionId);
  }

  /**
   * The person’s Send now on one waiting entry: once the agent’s turn is stopped, a turn takes it alone. Returns whether
   * it was still waiting. @param {{ id: string, sessionId: string }} entry
   */
  takeAlone(entry) {
    return sendEntryAlone(this.rt, entry);
  }

  /**
   * What waited on a turn, given once the turn ended or its stopped process exited: a message held for the agent
   * while it was busy, in order. @param {string} sessionId @param {any} message @param {{ summarizeTo?: string|null, threadId?: string|null }} [opts]
   */
  release(sessionId, message, opts) {
    this.run(sessionId, message, opts);
  }

  /**
   * A host turn resumed, or attached again, after a restart or a lost link (server/remote/turns-resume.mjs).
   * @param {string} sessionId @param {any} message @param {{ summarizeTo?: string|null, threadId?: string|null }} [opts]
   */
  resume(sessionId, message, opts) {
    this.run(sessionId, message, opts);
  }

  /**
   * The person’s Retry of a failed turn that took entries: they reopen as a resend (Delivery’s retry), marked with
   * whom the failed reply already woke (#485), and the session is no longer failed, since the person acted. Whichever
   * turn takes them is built from them, and is the retry (retryMarks in turns.mjs). Returns whether the turn took any.
   * @param {string} sessionId @param {string} turnId  the failed turn @param {string[]} woken
   */
  retryEntries(sessionId, turnId, woken) {
    if (!this.rt.delivery.retry(turnId, woken).length) return false;
    if (this.rt.store.pending.session(sessionId)?.state === 'failed') this.rt.sessions.update(sessionId, { state: 'idle' });
    this.rt.delivery.wake(sessionId);
    return true;
  }

  /**
   * The person’s Retry of a failed reply. @param {string} threadId @param {string} itemId
   * @param {() => void} [onSend]  runs once the retry is sent, before its turn starts (turn-transient.mjs)
   */
  retry(threadId, itemId, onSend) {
    return retry(this.rt, threadId, itemId, onSend);
  }

  /**
   * The step every start goes through: builds the turn from its message and runs it, or holds it until it can start
   * (a session behind a held commit, writes closed, a stopped turn still exiting). Its own steps call it, and so do
   * tests that start a turn with a message of their own.
   * @param {string} sessionId @param {any} message @param {{ summarizeTo?: string|null, threadId?: string|null }} [opts]
   */
  run(sessionId, message, opts) {
    return deliver(this.rt, sessionId, message, opts);
  }
}
