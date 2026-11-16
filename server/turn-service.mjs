// Turns (designs/architecture/services.md, “Delivery and Turns, built as the inbox”, Turns): the one way an agent’s
// turn starts. Every start is one of its steps, by what starts it: the agent’s waiting entries (start); the person’s
// Send now on one of them (takeAlone); what waited on a turn, given once it ended or its process exited (release); a
// host turn resumed or attached again after a restart (resume); and the person’s Retry of a failed reply (retry). Each
// goes through run, which builds the turn and hands it to its adapter (server/deliver.mjs). Built by the composition
// root as `rt.turnService`, since `rt.turns` is Running’s map of live turns; it takes the Runtime until the rest of
// what a turn reads is a service.

import { deliver, retry } from './deliver.mjs';
import { sendEntryAlone } from './entry-queue.mjs';
import { startFromEntries } from './turns.mjs';

export class Turns {
  /** @param {any} rt */
  constructor(rt) {
    this.rt = rt;
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

  /** The person’s Retry of a failed reply. @param {string} threadId @param {string} itemId */
  retry(threadId, itemId) {
    return retry(this.rt, threadId, itemId);
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
