// Summaries (designs/architecture/services.md, “Memory”, split off in step 10): after a topic or side thread’s last
// reply settles, one cheap model call writes a short summary on the thread’s line, which the conversation’s other
// agents read with it (#228). It’s never written while a turn speaks in the thread or Postbox closes, and its cost goes
// on the work ledger. Summaries is a service: Runtime’s constructor builds it with the store, Threads, Sessions,
// Personas and Running, the ledger, the adapter registry and the server’s settings, and thread-summary.mjs takes it,
// never the runtime. It reads nothing of Memory’s, and Memory only reads the summary it wrote, from the store.

import { settleThread, stopSummaryTimers, summarizerOf, summarizeThread } from './thread-summary.mjs';

/** @typedef {(prompt: string) => Promise<{ text: string, costUsd?: number|null } | null>} Summarize */

export class Summaries {
  /**
   * @param {{ store: import('./store.mjs').Store, threads: import('./threads.mjs').Threads,
   *           sessions: { in: (threadId: string) => any[] }, personas: { get: (id: string) => any },
   *           running: { all: () => any[], exiting: Map<string, any>, closing: boolean },
   *           ledger: { convOf: (threadId: string) => string, entry: (conv: string, id: string) => any, patch: (conv: string, id: string, patch: any) => any },
   *           adapters: { names: () => string[], get: (name: string) => any },
   *           config: Record<string, any> & { setTimer?: Function, summaryDelayMs?: number } }} deps
   *   ledger: the work ledger, which Work holds too. adapters: where the Agent SDK is found, for Haiku. config: the
   *   server’s settings, where a test shortens the wait or gives its own timers.
   */
  constructor({ store, threads, sessions, personas, running, ledger, adapters, config }) {
    this.store = store;
    this.threads = threads;
    this.sessions = sessions;
    this.personas = personas;
    this.running = running;
    this.ledger = ledger;
    this.adapters = adapters;
    this.config = config;
    /** @type {Map<string, any>} thread id → the timer of its summary waiting to be written, so a burst of replies makes one call */
    this.timers = new Map();
    /** @type {Summarize | undefined} the model a test gives in place of Haiku (tests/arrange-fakes.mjs, withSummarizer) */
    this.summarize = undefined;
  }

  /** A turn ended in a topic or side thread: once the thread is quiet, its summary is written. @param {string} threadId */
  settleThread(threadId) {
    settleThread(this, threadId);
  }

  /** Writes a thread’s summary now, with the model given, and returns it, or null. @param {string} threadId @param {Summarize} summarize */
  summarizeThread(threadId, summarize) {
    return summarizeThread(this, threadId, summarize);
  }

  /** The model that summarizes a thread, or null when there is none. @param {string} threadId */
  summarizerOf(threadId) {
    return summarizerOf(this, threadId);
  }

  /** As Postbox closes: no summary still waiting is written. */
  stopTimers() {
    stopSummaryTimers(this);
  }
}
