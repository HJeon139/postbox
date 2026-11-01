// The runtime’s archive passes (#305): when a turn ends and once after start, a conversation’s older ended turns move
// to archive files (server/work-archive.mjs). The runtime owns the passes and ends them before the Store closes.
//
// Off by default. A pass removes work entries and reply steps from the live state, and the readers that give them
// back (the Work view’s totals, the detail routes, the ledger’s lookups, telemetry and the room checks) are not in yet,
// so a pass would make those answers wrong. `enabled` stays false until they land; tests turn it on.

import { archiveTurns } from './work-archive.mjs';

/** How long shutdown waits for a running pass before going on without it. */
export const ARCHIVE_STOP_MS = 3000;

export class ArchivePasses {
  /** @param {any} rt @param {{ enabled?: boolean }} [options] */
  constructor(rt, { enabled = false } = {}) {
    this.rt = rt;
    this.enabled = enabled;
    /** @type {Map<string, Promise<number>>} one pass at a time per conversation */
    this.chains = new Map();
    /** Shutting down: no new pass. Never reset, since a runtime that stopped its passes is closing for good. */
    this.closing = false;
  }

  /**
   * Runs the pass for a conversation after any pass already queued for it, so the turn-end pass and the one after start
   * never overlap. Resolves with how many turns it archived, and never rejects.
   * @param {string} convId
   */
  conversation(convId) {
    if (!this.enabled || this.closing) return Promise.resolve(0);
    const run = (this.chains.get(convId) ?? Promise.resolve(0)).then(() => this.once(convId));
    this.chains.set(convId, run);
    run.then(() => {
      if (this.chains.get(convId) === run) this.chains.delete(convId);
    });
    return run;
  }

  /** Settles when no pass is queued for the conversation. @param {string} convId */
  idle(convId) {
    return this.chains.get(convId) ?? Promise.resolve(0);
  }

  /** After start: every conversation’s older turns, one conversation at a time, yielding between them. */
  async all() {
    for (const t of Object.values(this.rt.s.threads)) {
      if (this.closing) return;
      if (t.parentId || t.deleting) continue;
      await this.conversation(t.id);
      await new Promise((r) => setImmediate(r));
    }
  }

  /**
   * Ends the passes before the Store closes: no new pass starts, and this resolves when the queued ones have settled,
   * or after `boundMs`. A disk that doesn’t answer must not keep the Store open, and a put that lands later leaves at
   * most an unused archive file.
   * @param {number} [boundMs]
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

  /** The turns that must stay live: running, or with a job kept running after a Stop. Read for each turn. */
  running() {
    const running = new Set([...this.rt.turns.values()].map((t) => t.id));
    for (const se of Object.values(this.rt.s.sessions)) for (const j of se.jobs ?? []) if (j.kept && j.turnId) running.add(j.turnId);
    return running;
  }

  /** One pass. Failures are logged once and not retried: the next turn’s end tries again. @param {string} convId */
  async once(convId) {
    const { store, s } = this.rt;
    // Before every file the pass puts: the store writable, not shutting down, the conversation still there, and not
    // being deleted (its Undo window).
    const canWrite = () => store.writable && !this.closing && Boolean(s.threads[convId]) && !s.threads[convId].deleting;
    if (!canWrite()) return 0;
    try {
      return await archiveTurns({ store, blobs: this.rt.ledger.blobs, convId, running: () => this.running(), canWrite });
    } catch (e) {
      // Shutting down, or the store closed under the pass: nothing to report.
      if (this.closing || /** @type {any} */ (e)?.code === 'ECLOSED' || !store.writable) return 0;
      console.warn(
        `Old turns in ${s.threads[convId]?.title ?? convId} weren’t archived: ${e instanceof Error ? e.message : e}. The next turn’s end tries again.`,
      );
      return 0;
    }
  }
}
