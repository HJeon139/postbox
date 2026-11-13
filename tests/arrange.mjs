// The one place tests reach past Runtime’s facade, to arrange a room or read what the server holds
// (designs/architecture/services.md, “The fixture: arranging without the facade”). Browser specs and unit tests import
// it as `* as arrange`; routes and the agent tools never do. Each helper takes the runtime first, and is built today on
// Runtime’s own members and the server functions that take it: the step that redoes a concern as a service changes
// that concern’s helpers here, and no spec.

import { assetTools as assetToolsOf } from '../server/asset-tools.mjs';
import { expireWait as expireWaitOf } from '../server/permission-cards.mjs';
import { toggleReaction } from '../server/reactions.mjs';
import { blockFiles as blockFilesOf } from '../server/review-files.mjs';
import { updateThread } from '../server/thread-write.mjs';
import { viewApp as viewAppOf } from '../server/view-app/view-app.mjs';
import { viewOf } from '../server/view-app/view-of.mjs';

export * from './arrange-work.mjs';

/** @typedef {import('../server/runtime.mjs').Runtime} Runtime */

// ── Agents and personas ──────────────────────────────────────────────────────────────

/** The agents’ sessions in a thread, in the order they joined. @param {Runtime} rt @param {string} threadId */
export const sessionsIn = (rt, threadId) => rt.sessionsIn(threadId);

/**
 * One agent’s session in a thread: the one with that handle, or the first to join when no handle is given. A handle
 * given as undefined finds none, as a search for it would.
 * @param {Runtime} rt @param {string} threadId @param {[string?]} handle
 */
export function agentIn(rt, threadId, ...handle) {
  const all = rt.sessionsIn(threadId);
  return handle.length ? all.find((se) => se.handle === handle[0]) : all[0];
}

/** The persona with that handle, ignoring case, among those not retired. @param {Runtime} rt @param {string} handle */
export const persona = (rt, handle) => rt.personaByHandle(handle);

/** The persona a session runs with, with its settings as a turn takes them. @param {Runtime} rt @param {object} se */
export const personaFor = (rt, se) => rt.personaFor(/** @type {any} */ (se));

/** Changes a session’s record, as the server does when its state moves on. @param {Runtime} rt @param {string} id @param {object} patch */
export const setSession = (rt, id, patch) => rt.updateSession(id, patch);

/** Offers an agent’s slash commands, as its backend reports them when a turn starts. @param {Runtime} rt @param {string} sessionId @param {object[]} list */
export const offerCommands = (rt, sessionId, list) => rt.recordCommands(sessionId, list);

// ── Threads and items ────────────────────────────────────────────────────────────────

/** Adds an item to a thread, as if an agent, the person or the server had posted it, and returns it. @param {Runtime} rt @param {string} threadId @param {object} item */
export const post = (rt, threadId, item) => rt.addItem(threadId, item);

/** Changes an item in place. @param {Runtime} rt @param {string} threadId @param {string} itemId @param {object} patch */
export const setItem = (rt, threadId, itemId, patch) => rt.patchItem(threadId, itemId, patch);

/** Writes a thread’s record as given: a new side or topic thread, or one with fields changed. @param {Runtime} rt @param {object} thread */
export const putThread = (rt, thread) => rt.putThread(thread);

/** Changes fields of a thread that exists, as the server’s own writes do. @param {Runtime} rt @param {string} threadId @param {object} patch */
export const setThread = (rt, threadId, patch) => updateThread(rt, threadId, patch);

/** Renames a thread, as an agent’s title or the person’s edit does. @param {Runtime} rt @param {string} threadId @param {string} title */
export const renameThread = (rt, threadId, title) => rt.renameThread(threadId, title);

/**
 * Moves an item to the end of its thread with a stub in its old place, as an app’s new version or a block that asks
 * again does. @param {Runtime} rt @param {string} threadId @param {string} itemId @param {object} stub @param {object} [patch]
 */
export const moveToEnd = (rt, threadId, itemId, stub, patch) => rt.bringForward(threadId, itemId, stub, patch);

/** An agent’s reaction to a message, or the person’s when `by` is left out. @param {Runtime} rt @param {string} threadId @param {string} itemId @param {string} emoji @param {object} [by] */
export const react = (rt, threadId, itemId, emoji, by) => toggleReaction(rt, threadId, itemId, emoji, by);

/** Shares text into a conversation from a topic or side thread, as a summary or an answer. @param {Runtime} rt @param {string} threadId @param {object} opts */
export const shareText = (rt, threadId, opts) => rt.shareText(threadId, opts);

// ── Turns ────────────────────────────────────────────────────────────────────────────

/** The turn running for a session, if one is. @param {Runtime} rt @param {string} sessionId */
export const liveTurn = (rt, sessionId) => rt.turns.get(sessionId);

/** The token of the turn running for a session, which its MCP calls carry, or null when none runs. @param {Runtime} rt @param {string} sessionId */
export const turnToken = (rt, sessionId) => rt.turns.get(sessionId)?.token ?? null;

/** Ends the turn running for a session as its agent’s process ending would: aborts it. @param {Runtime} rt @param {string} sessionId */
export function abortTurn(rt, sessionId) {
  /** @type {any} */ (rt.turns.get(sessionId)).abort.abort();
}

/** How many messages wait for the turn running for a session. @param {Runtime} rt @param {string} sessionId */
export const heldMessages = (rt, sessionId) => /** @type {any} */ (rt.turns.get(sessionId)).pending.length;

/** Whether a turn is running for a session. @param {Runtime} rt @param {string} sessionId */
export const running = (rt, sessionId) => rt.turns.has(sessionId);

/** How many turns are running. @param {Runtime} rt */
export const liveTurns = (rt) => rt.turns.size;

/** Whether a session’s stopped turn is still exiting. @param {Runtime} rt @param {string} sessionId */
export const exiting = (rt, sessionId) => rt.exiting.has(sessionId);

/** How many stopped turns are still exiting. @param {Runtime} rt */
export const exitingTurns = (rt) => rt.exiting.size;

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
export const shellRuns = (rt) => rt.shellRuns.size;

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

/** The files an app’s show carries, read from the agent’s folders. @param {Runtime} rt @param {string} sessionId @param {object} args */
export const appFiles = (rt, sessionId, args) => rt.appFiles(sessionId, args);

/** The files a block’s show carries. @param {Runtime} rt @param {string} sessionId @param {string} name @param {object} args */
export const blockFiles = (rt, sessionId, name, args) => blockFilesOf(rt, sessionId, name, args);

/** An agent’s asset tools. @param {Runtime} rt @param {string} sessionId @param {any} turn @param {object} [opts] */
export const assetTools = (rt, sessionId, turn, opts) => assetToolsOf(rt, sessionId, turn, opts);

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

// ── Fakes ────────────────────────────────────────────────────────────────────────────

/** Registers a fake backend under its own name, replacing any of that name. @param {Runtime} rt @param {object} adapter @param {object} [opts] */
export const withAdapter = (rt, adapter, opts) => rt.adapters.register(/** @type {any} */ (adapter), opts);

/** Unregisters a backend. @param {Runtime} rt @param {string} name */
export const withoutAdapter = (rt, name) => rt.adapters.adapters.delete(name);

/** The backend registered under a name. @param {Runtime} rt @param {string} name */
export const adapter = (rt, name) => rt.adapters.get(name);

/** What a registered backend can do. @param {Runtime} rt @param {string} name */
export const capabilitiesOf = (rt, name) => rt.adapters.get(name).capabilities;

/** The names of the backends registered. @param {Runtime} rt */
export const adapterNames = (rt) => rt.adapters.names();

/**
 * Fakes the processes Postbox lists and signals, to stop a turn’s or a kept job’s process tree without one. Returns a
 * function that puts back what it replaced.
 * @param {Runtime} rt @param {{ list?: () => Promise<object[]>, signal?: (pid: number, sig: string) => any }} fakes
 */
export function withProcesses(rt, { list, signal }) {
  const was = { list: rt.listProcesses, signal: rt.signalProcess };
  if (list) rt.listProcesses = /** @type {any} */ (list);
  if (signal) rt.signalProcess = /** @type {any} */ (signal);
  return () => {
    if (list) rt.listProcesses = was.list;
    if (signal) rt.signalProcess = was.signal;
  };
}

/**
 * Sets one of the seams the server looks for before its own (rt.judge, rt.pushes, rt.summarize), or removes it, given
 * undefined, so the server’s own runs again. @param {Runtime} rt @param {string} name @param {any} value
 */
function seam(rt, name, value) {
  const r = /** @type {any} */ (rt);
  if (value === undefined) delete r[name];
  else r[name] = value;
}

/** Replaces the model that judges a write’s intent; undefined restores the real one. @param {Runtime} rt @param {any} judge */
export const withJudge = (rt, judge) => seam(rt, 'judge', judge);

/** Replaces how a push is read and run; undefined restores the real one. @param {Runtime} rt @param {any} pushes */
export const withPushes = (rt, pushes) => seam(rt, 'pushes', pushes);

/** Replaces the model that summarizes a thread; undefined restores the real one. @param {Runtime} rt @param {any} summarize */
export const withSummarizer = (rt, summarize) => seam(rt, 'summarize', summarize);

/**
 * Hears each notification the server raises, before it goes out as it would. Returns a function that stops listening.
 * @param {Runtime} rt @param {(level: string, ...rest: any[]) => void} fn
 */
export function onNotify(rt, fn) {
  const notify = rt.notify.bind(rt);
  rt.notify = (level, ...rest) => {
    fn(level, ...rest);
    return notify(level, ...rest);
  };
  return () => {
    rt.notify = notify;
  };
}
