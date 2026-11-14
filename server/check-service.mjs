// Checks (designs/architecture/services.md, “Checks”): the server’s checks on a finished turn and the stalled-step
// checks (turn-checks.mjs), the lint entry each agent turn gets, with its timer, and the lint turn its problems go
// back in (lint-delivery.mjs), and the page’s reports on the diagrams it drew (diagram-check.mjs). Checks is a service:
// Runtime’s constructor builds it with the store, Threads, Sessions and Running, the server’s settings, and the `send`
// port, and its modules take it, never the runtime. A lint turn reaches its agent only through `send`.

import { diagramCheck } from './diagram-check.mjs';
import { foldLint, lint, quietLint, stopLintTimers } from './lint-delivery.mjs';
import { endChecks, stallLeftRunning, stallSteps } from './turn-checks.mjs';

export class Checks {
  /**
   * @param {{ store: import('./store.mjs').Store, threads: import('./threads.mjs').Threads,
   *           sessions: { update: (id: string, patch: any) => any, tell: (id: string, text: string) => any },
   *           running: { all: () => any[] }, send: (sessionId: string, message: any, opts: { threadId: string|null }) => unknown,
   *           config: { lintSettleMs?: number, lintWaitMaxMs?: number, now?: () => number, setTimer?: Function } }} deps
   *   send: a message for an agent (the port; designs/architecture/services.md, “The services”), which the root binds
   *   to the runtime’s deliver. config: the server’s settings, where a test shortens the lint turn’s wait or gives its
   *   own clock and timers.
   */
  constructor({ store, threads, sessions, running, send, config }) {
    this.store = store;
    this.threads = threads;
    this.sessions = sessions;
    this.running = running;
    this.send = send;
    this.config = config;
    /** @type {Map<string, any>} agent turn id → its lint turn, gathering: { sessionId, kind, ended, sent, problems, timer, threadId } */
    this.lints = new Map();
  }

  // ── A finished turn ────────────────────────────────────────────────────────────────

  /** The turn ended: its steps left running stall, then its problems go back in a lint turn, or a quiet lint turn leaves its line. @param {any} turn @param {any} se */
  endTurn(turn, se) {
    endChecks(this, turn, se);
  }

  /** A lint turn that wrote nothing shows as one line. @param {any} turn @param {any} se */
  quietLint(turn, se) {
    quietLint(this, turn, se);
  }

  // ── Problems after the turn ────────────────────────────────────────────────────────

  /**
   * Adds problems to the lint turn of the agent turn they came from, and answers whether the agent will hear of them.
   * @param {string} sessionId @param {string|null|undefined} turnId @param {import('./checks.mjs').Problem[]} problems
   */
  lint(sessionId, turnId, problems) {
    return lint(this, sessionId, turnId, problems);
  }

  /** Another turn starts: the lint turns still settling join its message instead. @param {string} sessionId @param {any} message */
  foldLint(sessionId, message) {
    return foldLint(this, sessionId, message);
  }

  // ── Stalled steps (#58, #98) ───────────────────────────────────────────────────────

  /** The progress steps a turn left running, marked stalled, as problems. @param {any} turn @param {any} se */
  stallSteps(turn, se) {
    return stallSteps(this, turn, se);
  }

  /** A turn stopped or failed: its agent hears at its next turn which steps stalled. @param {any} turn @param {any} se @param {'stopped' | 'failed' | 'shutdown' | 'hung'} how */
  stallLeftRunning(turn, se, how) {
    stallLeftRunning(this, turn, se, how);
  }

  // ── The page’s diagram reports ─────────────────────────────────────────────────────

  /** The browser drew a diagram, or couldn’t. @param {string} threadId @param {string} itemId @param {any} report */
  diagramCheck(threadId, itemId, report) {
    return diagramCheck(this, threadId, itemId, report);
  }

  /** As Postbox closes: no lint turn still settling goes. */
  stopTimers() {
    stopLintTimers(this);
  }
}
