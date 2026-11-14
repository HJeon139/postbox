// The one place tests reach past Runtime’s facade, to arrange a room or read what the server holds
// (designs/architecture/services.md, “The fixture: arranging without the facade”). Browser specs and unit tests import
// it as `* as arrange`; routes and the agent tools never do. Each helper takes the runtime first, and is built today on
// Runtime’s own members and the server functions that take it: the step that redoes a concern as a service changes
// that concern’s helpers here, and no spec.

import { hostTool as hostToolOf } from '../server/host-tool.mjs';
import { expireWait as expireWaitOf } from '../server/permission-cards.mjs';
import { viewApp as viewAppOf } from '../server/view-app/view-app.mjs';
import { viewOf } from '../server/view-app/view-of.mjs';

export * from './arrange-fakes.mjs';
export * from './arrange-work.mjs';

/** @typedef {import('../server/runtime.mjs').Runtime} Runtime */

// ── Agents and personas ──────────────────────────────────────────────────────────────

/** The agents’ sessions in a thread, in the order they joined. @param {Runtime} rt @param {string} threadId */
export const sessionsIn = (rt, threadId) => rt.sessions.in(threadId);

/**
 * One agent’s session in a thread: the one with that handle, or the first to join when no handle is given. A handle
 * given as undefined finds none, as a search for it would.
 * @param {Runtime} rt @param {string} threadId @param {[string?]} handle
 */
export function agentIn(rt, threadId, ...handle) {
  const all = rt.sessions.in(threadId);
  return handle.length ? all.find((se) => se.handle === handle[0]) : all[0];
}

/** The persona with that handle, ignoring case, among those not retired. @param {Runtime} rt @param {string} handle */
export const persona = (rt, handle) => rt.personas.byHandle(handle);

/** The persona a session runs with, with its settings as a turn takes them. @param {Runtime} rt @param {object} se */
export const personaFor = (rt, se) => rt.personas.forSession(/** @type {any} */ (se));

/** Changes a session’s record, as the server does when its state moves on. @param {Runtime} rt @param {string} id @param {object} patch */
export const setSession = (rt, id, patch) => rt.sessions.update(id, patch);

/** Leaves a Postbox notice for an agent’s next turn, as the server does. @param {Runtime} rt @param {string} sessionId @param {string} text */
export const tell = (rt, sessionId, text) => rt.sessions.tell(sessionId, text);

/** The other agents in a thread’s conversation, with their roles, as the guide gives them. @param {Runtime} rt @param {string} threadId @param {object} se */
export const roomOf = (rt, threadId, se) => rt.sessions.roomOf(threadId, /** @type {any} */ (se));

/** Offers an agent’s slash commands, as its backend reports them when a turn starts. @param {Runtime} rt @param {string} sessionId @param {object[]} list */
export const offerCommands = (rt, sessionId, list) => rt.sessions.recordCommands(sessionId, list);

// ── Threads and items ────────────────────────────────────────────────────────────────

/** Adds an item to a thread, as if an agent, the person or the server had posted it, and returns it. @param {Runtime} rt @param {string} threadId @param {object} item */
export const post = (rt, threadId, item) => rt.threads.addItem(threadId, item);

/** Changes an item in place. @param {Runtime} rt @param {string} threadId @param {string} itemId @param {object} patch */
export const setItem = (rt, threadId, itemId, patch) => rt.threads.patchItem(threadId, itemId, patch);

/** Writes a thread’s record as given: a new side or topic thread, or one with fields changed. @param {Runtime} rt @param {object} thread */
export const putThread = (rt, thread) => rt.threads.put(thread);

/** Changes fields of a thread that exists, as the server’s own writes do. @param {Runtime} rt @param {string} threadId @param {object} patch */
export const setThread = (rt, threadId, patch) => rt.threads.patch(threadId, patch);

/** Renames a thread, as an agent’s title or the person’s edit does. @param {Runtime} rt @param {string} threadId @param {string} title */
export const renameThread = (rt, threadId, title) => rt.threads.rename(threadId, title);

/**
 * Moves an item to the end of its thread with a stub in its old place, as an app’s new version or a block that asks
 * again does. @param {Runtime} rt @param {string} threadId @param {string} itemId @param {object} stub @param {object} [patch]
 */
export const moveToEnd = (rt, threadId, itemId, stub, patch) => rt.threads.bringForward(threadId, itemId, stub, patch);

/** An agent’s reaction to a message, or the person’s when `by` is left out. @param {Runtime} rt @param {string} threadId @param {string} itemId @param {string} emoji @param {object} [by] */
export const react = (rt, threadId, itemId, emoji, by) => rt.threads.toggleReaction(threadId, itemId, emoji, by);

/** A thread, then the conversation it branched from. @param {Runtime} rt @param {string} threadId */
export const lineage = (rt, threadId) => rt.threads.lineage(threadId);

/** Every thread of a thread’s conversation, its lineage first. @param {Runtime} rt @param {string} threadId */
export const conversationThreads = (rt, threadId) => rt.threads.conversationThreads(threadId);

/** The terms a thread knows, its own over its conversation’s. @param {Runtime} rt @param {string} threadId */
export const glossaryFor = (rt, threadId) => rt.threads.glossaryFor(threadId);

/** Shares text into a conversation from a topic or side thread, as a summary or an answer. @param {Runtime} rt @param {string} threadId @param {object} opts */
export const shareText = (rt, threadId, opts) => rt.shareText(threadId, opts);

// ── Turns ────────────────────────────────────────────────────────────────────────────

/** The turn running for a session, if one is. @param {Runtime} rt @param {string} sessionId */
export const liveTurn = (rt, sessionId) => rt.running.turnOf(sessionId);

/** The token of the turn running for a session, which its MCP calls carry, or null when none runs. @param {Runtime} rt @param {string} sessionId */
export const turnToken = (rt, sessionId) => rt.running.turnOf(sessionId)?.token ?? null;

/** Ends the turn running for a session as its agent’s process ending would: aborts it. @param {Runtime} rt @param {string} sessionId */
export function abortTurn(rt, sessionId) {
  /** @type {any} */ (rt.running.turnOf(sessionId)).abort.abort();
}

/** How many messages wait for the turn running for a session. @param {Runtime} rt @param {string} sessionId */
export const heldMessages = (rt, sessionId) => /** @type {any} */ (rt.running.turnOf(sessionId)).pending.length;

/** Whether a turn is running for a session. @param {Runtime} rt @param {string} sessionId */
export const running = (rt, sessionId) => Boolean(rt.running.turnOf(sessionId));

/** How many turns are running. @param {Runtime} rt */
export const liveTurns = (rt) => rt.running.all().length;

/** Whether a session’s stopped turn is still exiting. @param {Runtime} rt @param {string} sessionId */
export const exiting = (rt, sessionId) => Boolean(rt.running.exitOf(sessionId));

/** How many stopped turns are still exiting. @param {Runtime} rt */
export const exitingTurns = (rt) => rt.running.exiting.size;

/** Postbox starts shutting down, as stopTurns marks it first: no new turn starts. @param {Runtime} rt */
export const shuttingDown = (rt) => rt.running.close();

/** Gives an agent a message, starting its turn or queueing it. @param {Runtime} rt @param {string} sessionId @param {object} message @param {object} [opts] */
export const deliver = (rt, sessionId, message, opts) => rt.deliver(sessionId, message, opts);

/** One agent wakes another by handle, as its wake tool does. @param {Runtime} rt @param {string} fromSessionId @param {string} handle @param {string} text @param {object} [opts] */
export const wake = (rt, fromSessionId, handle, text, opts) => rt.agentWake(fromSessionId, handle, text, opts);

/** Stops a session’s turn, as the server does. @param {Runtime} rt @param {string} sessionId @param {object} [opts] */
export const stopTurn = (rt, sessionId, opts) => rt.stop(sessionId, opts);

/** Schedules a wake for an agent, as its schedule tool does. @param {Runtime} rt @param {string} sessionId @param {object} options */
export const schedule = (rt, sessionId, options) => rt.schedule(sessionId, options);

/** How many scheduled wakes wait on a timer. @param {Runtime} rt */
export const scheduledTimers = (rt) => rt.timers.size;

/** Whether a scheduled wake waits on its timer. @param {Runtime} rt @param {string} scheduleId */
export const scheduledTimer = (rt, scheduleId) => rt.timers.has(scheduleId);

/** Clears a scheduled wake’s timer, so it can’t fire; the schedule and its line stay as they were. @param {Runtime} rt @param {string} scheduleId */
export function cancelScheduledTimer(rt, scheduleId) {
  clearTimeout(rt.timers.get(scheduleId));
  rt.timers.delete(scheduleId);
}

/**
 * Holds a turn on a host as stopping, so a remove or update of that host waits for it, until the returned function
 * lets it go. @param {Runtime} rt @param {string} turnId @param {object} entry
 */
export function stoppingOnHost(rt, turnId, entry) {
  rt.remote.stopping.set(turnId, /** @type {any} */ (entry));
  return () => rt.remote.stopping.delete(turnId);
}

/** How many permission cards wait for an answer. @param {Runtime} rt */
export const permissionWaits = (rt) => rt.permissionWaits.size;

/** How many of the person’s ! commands are running. @param {Runtime} rt */
export const shellRuns = (rt) => rt.work.shellRuns.size;

/** Whether a mirror follows a session’s Claude Code transcript. @param {Runtime} rt @param {string} sessionId */
export const mirrored = (rt, sessionId) => rt.mirrors.has(sessionId);

/** Gives a session’s mirror a fake tail of its transcript, whose poll returns the lines typed since the last. @param {Runtime} rt @param {string} sessionId @param {{ poll: () => object[] }} tail */
export function withMirrorTail(rt, sessionId, tail) {
  /** @type {any} */ (rt.mirrors.get(sessionId)).tail = tail;
}

// ── Permissions, apps and files ──────────────────────────────────────────────────────

/** What Always would allow for a request. @param {Runtime} rt @param {object} se @param {object} req */
export const alwaysFor = (rt, se, req) => rt.alwaysFor(se, req);

/** Expires a permission card’s wait, as its timeout does. @param {Runtime} rt @param {string} itemId */
export const expireWait = (rt, itemId) => expireWaitOf(rt, itemId);

/** The folders an agent works in: its own, the project’s, and any added. @param {Runtime} rt @param {string} sessionId */
export const agentFolders = (rt, sessionId) => rt.assets.agentFolders(sessionId);

/** Where a message’s attachment can be read on disk, or null. @param {Runtime} rt @param {string} threadId @param {object} a */
export const attachmentPath = (rt, threadId, a) => rt.assets.attachmentPath(threadId, a);

/** The files an app’s show carries, read from the agent’s folders. @param {Runtime} rt @param {string} sessionId @param {object} args */
export const appFiles = (rt, sessionId, args) => rt.assets.appFiles(sessionId, args);

/** The files a block’s show carries. @param {Runtime} rt @param {string} sessionId @param {string} name @param {object} args */
export const blockFiles = (rt, sessionId, name, args) => rt.assets.blockFiles(sessionId, name, args);

/** An agent’s asset tools. @param {Runtime} rt @param {string} sessionId @param {any} turn @param {object} [opts] */
export const assetTools = (rt, sessionId, turn, opts) => rt.assets.tools(sessionId, turn, /** @type {any} */ (opts));

// ── Apps and blocks ──────────────────────────────────────────────────────────────────

/**
 * Shows a block for an agent, as its show_block tool does, in the turn context ctx gives: { turn, se, threadId,
 * endSegment, tools }. @param {Runtime} rt @param {string} sessionId @param {any} ctx @param {{ block: any }} args
 */
export const showBlock = (rt, sessionId, ctx, args) => rt.apps.showBlock(sessionId, ctx, args);

/**
 * Runs a host tool an app asked for, as the app’s query does, in the conversation `at` names.
 * @param {Runtime} rt @param {string} tool @param {any} args @param {{ threadId?: string }} [at]
 */
export const hostTool = (rt, tool, args, at) => hostToolOf(rt.apps, tool, args, at);

/** The folder where view_app keeps its browser and the person’s answer about downloading it. @param {Runtime} rt */
export const viewDir = (rt) => viewOf(rt).dir;

/** The window size and theme the page last reported to view_app, as it lays an app out. @param {Runtime} rt */
export const viewWindow = (rt) => viewOf(rt).windowNow();

/** Forgets the window the page reported, as when no tab is open. @param {Runtime} rt */
export function forgetViewWindow(rt) {
  viewOf(rt).window = null;
}

/** An agent views an app, as its view tool does. @param {Runtime} rt @param {string} sessionId @param {object} args @param {object} ctx */
export const viewApp = (rt, sessionId, args, ctx) => viewAppOf(rt, sessionId, args, ctx);
