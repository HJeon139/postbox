// The runtime’s archive passes (#305; designs/305-archive-turns.md, “When the pass runs”): when a turn ends, and once
// after start, a conversation’s older ended turns move to archive files (server/work-archive.mjs). One promise chain
// per conversation, which both join, so two passes never archive one conversation at once; the runtime ends them
// before the store closes.
//
// Off unless `config.archiveTurns === true` (server/index.mjs passes it to new Runtime). A pass removes work entries and
// reply steps from the live state, and the readers that give them back aren’t all in yet; step 4 switches it on.

import { conversationDeleting } from './thread-erase.mjs';
import { archiveTurns } from './work-archive.mjs';

/** How long shutdown waits for a running pass before going on without it. */
export const ARCHIVE_STOP_MS = 3000;

const yieldNow = () => new Promise((r) => setImmediate(r));
const messageOf = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));

export class ArchivePasses {
  /** @param {any} rt  the runtime @param {{ enabled?: boolean }} [options] */
  constructor(rt, { enabled = false } = {}) {
    this.rt = rt;
    this.enabled = enabled;
    /** @type {Map<string, Promise<number>>} the last pass queued per conversation */
    this.chains = new Map();
    /** Shutting down: no new pass. Never reset, since a runtime that stopped its passes is closing for good. */
    this.closing = false;
  }

  /**
   * Runs the pass for a conversation after any pass already queued for it. Resolves with how many turns it archived,
   * and never rejects. O(1) to queue; the pass’s cost is archiveTurns’.
   * @param {string} convId
   */
  conversation(convId) {
    if (!this.enabled || this.closing) return Promise.resolve(0);
    const run = (this.chains.get(convId) ?? Promise.resolve(0)).then(() => this.once(convId));
    this.chains.set(convId, run);
    // The map holds only chains still running, so a quiet conversation costs nothing.
    run.then(() => this.chains.get(convId) === run && this.chains.delete(convId));
    return run;
  }

  /** Settles when no pass is queued for the conversation. @param {string} convId */
  idle(convId) {
    return this.chains.get(convId) ?? Promise.resolve(0);
  }

  /**
   * After start: every conversation, one at a time, yielding between them; each pass yields between its chunks too.
   * O(conversations) plus each pass.
   */
  async all() {
    // Off: nothing to walk, and no yield per thread for nothing at every start.
    if (!this.enabled) return;
    for (const t of Object.values(this.rt.s.threads)) {
      if (this.closing) return;
      if (t.parentId) continue;
      await this.conversation(t.id);
      await yieldNow();
    }
  }

  /**
   * Ends the passes before the store closes: no new pass starts, and this resolves when the queued ones have settled, or
   * after `boundMs`. A disk that doesn’t answer must not keep the store open, and a put that lands later leaves at most
   * an unused archive file. @param {number} [boundMs]
   */
  async stop(boundMs = ARCHIVE_STOP_MS) {
    this.closing = true;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    // Not unref’d: if nothing else keeps the event loop alive while a pass hangs, an unref’d timer would let the
    // process end before store.close() runs. It is cleared as soon as the passes settle.
    const late = new Promise((r) => {
      timer = setTimeout(() => r('late'), boundMs);
    });
    const result = await Promise.race([Promise.all([...this.chains.values()]), late]);
    clearTimeout(timer);
    if (result === 'late')
      console.warn(`An archive pass was still running after ${boundMs} ms; shutting down without it. It leaves at most an unused archive file.`);
  }

  /** The turns that must stay hot: running, or with a job kept running after a Stop. Read at each check. O(sessions’ jobs). */
  running() {
    const running = new Set([...this.rt.turns.values()].map((t) => t.id));
    for (const se of Object.values(this.rt.s.sessions)) for (const j of se.jobs ?? []) if (j.kept && j.turnId) running.add(j.turnId);
    return running;
  }

  /**
   * Whether the pass may put another file: the store writable, not shutting down, and the conversation there and not
   * in its delete’s Undo window. O(1).
   * @param {string} convId
   */
  canWrite(convId) {
    const { store, s } = this.rt;
    return store.writable && !this.closing && Boolean(s.threads[convId]) && !conversationDeleting(this.rt, convId);
  }

  /** One pass. A failure is logged once and not retried: the next turn’s end tries again. @param {string} convId */
  async once(convId) {
    const { store } = this.rt;
    const canWrite = () => this.canWrite(convId);
    if (!canWrite()) return 0;
    try {
      return await archiveTurns({ store, blobs: this.rt.ledger.blobs, convId, running: () => this.running(), canWrite });
    } catch (e) {
      // Shutting down, or the store closed under the pass: nothing to report.
      if (this.closing || /** @type {any} */ (e)?.code === 'ECLOSED' || !store.writable) return 0;
      const title = this.rt.s.threads[convId]?.title ?? convId;
      console.error(`Old turns in ${title} weren’t archived: ${messageOf(e)}. The next turn’s end tries again.`);
      return 0;
    }
  }
}
