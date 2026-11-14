// Ledger and work (designs/architecture/services.md, “Ledger and work”): what a conversation’s agents changed, ran and
// published (#132). The work ledger (server/ledger.mjs) records it; the work view’s answers to the page and a file put
// back (work-view.mjs), a turn’s tool calls as it runs (turn-work.mjs) and its work when it ends (turn-end-work.mjs),
// the passes that move older turns to archive files (archive-runtime.mjs, #305), and the person’s `!` commands
// (shell-runs.mjs, #67). Work is a service: Runtime’s constructor builds it with the store, Threads, Sessions,
// Personas, Placement and Running, the ledger and how a command starts, and its modules take it, never the runtime.

import { ArchivePasses } from './archive-runtime.mjs';
import { commandFolder, expireStaleCommands, flushShellOutput, runShellCommand, stopShellCommand, stopShellCommands } from './shell-runs.mjs';
import { endWork } from './turn-end-work.mjs';
import { workEvents } from './turn-work.mjs';
import { restoreWork, workDiff, workGit, workOutput } from './work-view.mjs';

export class Work {
  /**
   * @param {{ store: import('./store.mjs').Store, threads: import('./threads.mjs').Threads,
   *           sessions: { in: (threadId: string) => any[] }, personas: { forSession: (se: any) => any },
   *           placement: { requestAdapter: (handle: string, persona: any) => any, hereFolder: (persona: any, project: any, adapter: any) => Promise<{ folder: string|null, host: string|null }> },
   *           running: { all: () => any[] }, ledger: import('./ledger.mjs').Ledger,
   *           spawnShell?: typeof import('node:child_process').spawn, whenWritable: (fn: () => void) => void, archiveTurns?: boolean }} deps
   *   spawnShell: how a `!` command starts its process; tests pass a fake. whenWritable: runs fn once the store can be
   *   written (server/store-outage.mjs), until the Store is a service. archiveTurns: whether the archive passes run.
   */
  constructor({ store, threads, sessions, personas, placement, running, ledger, spawnShell, whenWritable, archiveTurns = false }) {
    this.store = store;
    this.threads = threads;
    this.sessions = sessions;
    this.personas = personas;
    this.placement = placement;
    this.ledger = ledger;
    this.spawnShell = spawnShell;
    this.whenWritable = whenWritable;
    /** @type {Map<string, any>} command item id → its run: { stop, kill, done, flush, stopped, closing } */
    this.shellRuns = new Map();
    // A conversation’s older turns move to archive files when a turn ends, and once after start (#305).
    this.archive = new ArchivePasses({ store, running, ledger }, { enabled: archiveTurns });
  }

  // ── The work view’s answers (#132) ─────────────────────────────────────────────────

  /** Where each changed file and commit stands in git now. @param {string} threadId */
  workGit(threadId) {
    return workGit(this, threadId);
  }

  /** A changed file’s diff, or one change’s. @param {string} threadId @param {string} fileId @param {string|null} [changeId] */
  workDiff(threadId, fileId, changeId) {
    return workDiff(this, threadId, fileId, changeId);
  }

  /** A command’s output, as the ledger kept it. @param {string} threadId @param {string} entryId */
  workOutput(threadId, entryId) {
    return workOutput(this, threadId, entryId);
  }

  /** Puts a file back as it was before the agents changed it, and says so in the conversation. @param {string} threadId @param {string} fileId */
  restoreWork(threadId, fileId) {
    return restoreWork(this, threadId, fileId);
  }

  // ── A turn’s work ──────────────────────────────────────────────────────────────────

  /** What the turn’s adapter reports of its tool calls and spend, each taken only while `live`. @param {any} turn @param {() => boolean} live */
  workEvents(turn, live) {
    return workEvents(this, turn, live);
  }

  /** The turn ended (done, stopped or failed): its work is recorded, then its last reply gets its line (#195). @param {any} turn @param {string} status */
  endWork(turn, status) {
    return endWork(this, turn, status);
  }

  /** Resolves once the ledger’s records in flight are written. */
  idle() {
    return this.ledger.idle();
  }

  // ── The archive passes (#305) ──────────────────────────────────────────────────────

  /** Once Postbox listens: every conversation’s older turns, one conversation at a time. */
  archiveAll() {
    return this.archive.all();
  }

  /** As Postbox shuts down: no new pass, and the running ones settle, for at most boundMs. @param {number} [boundMs] */
  stopArchive(boundMs) {
    return this.archive.stop(boundMs);
  }

  // ── The person’s `!` commands (#67) ────────────────────────────────────────────────

  /** Where a conversation’s `!` commands run, and the host its agent is on, if one. @param {string} threadId */
  commandFolder(threadId) {
    return commandFolder(this, threadId);
  }

  /** Runs `!command` as the person, in the conversation’s folder. @param {string} threadId @param {string} command */
  runShellCommand(threadId, command) {
    return runShellCommand(this, threadId, command);
  }

  /** Stop on a running command. @param {string} threadId @param {string} itemId */
  stopShellCommand(threadId, itemId) {
    return stopShellCommand(this, threadId, itemId);
  }

  /** Sends the running commands’ output that waits for its next flush now. */
  flushShellOutput() {
    flushShellOutput(this);
  }

  /** As Postbox shuts down: every running command gets SIGINT, then SIGKILL. @param {{ graceMs?: number }} [opts] */
  stopAll(opts) {
    return stopShellCommands(this, opts);
  }

  /** After a restart: the commands left running end, then the ledger’s records left running do. */
  expireStale() {
    expireStaleCommands(this);
    this.ledger.expireStale();
  }
}
