// Apps (designs/architecture/services.md, “Apps”): agents’ apps, their versions, saved state, host data and the
// browser’s check of each (apps.mjs, host-tool.mjs), retiring one (app-retire.mjs), the blocks an agent shows and
// updates (block-show.mjs, block-update.mjs), the person’s and other agents’ comments on a review (review-comments.mjs,
// review-person.mjs), and which answers an agent has read. Apps is a service: Runtime’s constructor builds it with the
// store, the bus, Threads, Sessions, Personas, Assets, Running and Checks, the `send` port, the narrator and the
// server’s settings, and its modules take it, never the runtime. The cards that hold what an app sends past its limit
// are asks’ (app-send-cards.mjs): retiring an app signals app.retired, and withdrawing a block block.withdrawn, so the
// needs they carried are released where the call was.

import { retireApp } from './app-retire.mjs';
import { appCheck, appEvent, appFile, appOf, appQuery, appState, registerApp, showApp, updateApp } from './apps.mjs';
import { showBlock } from './block-show.mjs';
import { answerDelivered, unreadAnswer, updateBlock } from './block-update.mjs';
import { reviewBlock } from './review-comments.mjs';
import { personAnswer } from './review-person.mjs';

/** @typedef {import('./agent-files.mjs').AppFile} AppFile */
/** @typedef {{ turn: any, se: () => any, threadId: () => string, endSegment: () => void }} TurnAt  where a tool acts, as toolsFor makes it */

export class Apps {
  /**
   * @param {{ store: import('./store.mjs').Store, bus: import('./bus.mjs').Bus, threads: import('./threads.mjs').Threads,
   *           sessions: { get: (id: string) => any }, personas: { forSession: (se: any) => any },
   *           assets: { blobs: any, search: (room: string, args: any) => Promise<any>, listText: (room: string) => Promise<any> },
   *           running: { all: () => any[], turnOf: (sessionId: string) => any },
   *           checks: { lint: (sessionId: string, turnId: string|null|undefined, problems: any[]) => unknown },
   *           send: (sessionId: string, message: any, opts: { threadId: string }) => unknown,
   *           narrator: { speak: (args: any) => any } | null, config: { imageOrigins: string[] } }} deps
   *   send: a message for an agent (the port; designs/architecture/services.md, “The services”), which the root binds to
   *   the runtime’s deliver. narrator: speaks for an app that asks, or null where it isn’t installed.
   */
  constructor({ store, bus, threads, sessions, personas, assets, running, checks, send, narrator, config }) {
    this.store = store;
    this.bus = bus;
    this.threads = threads;
    this.sessions = sessions;
    this.personas = personas;
    this.assets = assets;
    this.running = running;
    this.checks = checks;
    this.send = send;
    this.narrator = narrator;
    this.config = config;
  }

  // ── Apps ───────────────────────────────────────────────────────────────────────────

  /** An app the agent showed, at v1, pending its check. @param {string} sessionId @param {any} block @param {string} itemId @param {string} [threadId] @param {AppFile[]} [files] */
  register(sessionId, block, itemId, threadId, files) {
    registerApp(this, sessionId, block, itemId, threadId, files);
  }

  /** show_app: a new app, or a new version of the agent’s own. @param {string} sessionId @param {any} tools @param {any} args @param {{ files?: AppFile[] }} [given] */
  showApp(sessionId, tools, args, given) {
    return showApp(this, sessionId, tools, args, given);
  }

  /**
   * update_app: a new version of the agent’s app, brought to the newest point.
   * @param {string} sessionId @param {any} turn @param {() => string} threadId @param {() => void} endSegment @param {any} args @param {{ files?: AppFile[] }} [given]
   */
  updateApp(sessionId, turn, threadId, endSegment, args, given) {
    return updateApp(this, sessionId, turn, threadId, endSegment, args, given);
  }

  /** retire_app: the agent’s app shows as one line, and app.retired is signaled. @param {string} sessionId @param {any} args */
  retire(sessionId, args) {
    return retireApp(this, sessionId, args);
  }

  /** The browser’s check of a version, as its page reports it: { version, problems }. @param {string} appId @param {any} report */
  appCheck(appId, report) {
    return appCheck(this, appId, report);
  }

  /**
   * An event an app sends in the person’s voice: sent, or { hold: { app, card, event } } for asks to hold on its card.
   * @param {string} appId @param {string} action @param {object} values @param {{ hold?: boolean, now?: number }} [opts]
   */
  appEvent(appId, action, values, opts) {
    return appEvent(this, appId, action, values, opts);
  }

  /** The app’s saved state. @param {string} appId @param {unknown} state */
  appState(appId, state) {
    appState(this, appId, state);
  }

  /** A host tool an app asks for. @param {string} appId @param {string} tool @param {any} args */
  appQuery(appId, tool, args) {
    return appQuery(this, appId, tool, args);
  }

  /** A data file of an app’s version. @param {string} appId @param {string} name @param {number} [v] */
  appFile(appId, name, v) {
    return appFile(this, appId, name, v);
  }

  /** The app an item shows, on the app’s own item. @param {any} it */
  appOf(it) {
    return appOf(this, it);
  }

  // ── Blocks ─────────────────────────────────────────────────────────────────────────

  /**
   * show_block: a block, or an app. @param {string} sessionId @param {TurnAt & { tools: any }} at @param {{ block: any }} args
   * @param {{ files?: AppFile[], held?: boolean }} [given]
   */
  showBlock(sessionId, at, args, given) {
    return showBlock(this, sessionId, at, args, given);
  }

  /** update_block: a new revision, an outcome or a withdrawal. @param {string} sessionId @param {{ block: any }} args @param {TurnAt} at @param {any} [given] */
  updateBlock(sessionId, args, at, given) {
    return updateBlock(this, sessionId, args, at, given);
  }

  /** An answer is read once its event starts a turn (#123). @param {string} threadId @param {any} message */
  answerDelivered(threadId, message) {
    answerDelivered(this, threadId, message);
  }

  /** update_block’s refusal over an answer the agent hasn’t read. @param {string} sessionId @param {string} threadId @param {any} it @param {boolean} [outcome] */
  unreadAnswer(sessionId, threadId, it, outcome) {
    return unreadAnswer(this, sessionId, threadId, it, outcome);
  }

  // ── Reviews ────────────────────────────────────────────────────────────────────────

  /** review_block: another agent comments on a review. @param {string} sessionId @param {any} args */
  reviewBlock(sessionId, args) {
    return reviewBlock(this, sessionId, args);
  }

  /** What the person’s answer to a review writes beside it, or null. @param {any} given @param {any} event @param {number} revision */
  personAnswer(given, event, revision) {
    return personAnswer(this, given, event, revision);
  }
}
