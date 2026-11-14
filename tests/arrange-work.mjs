// The part of tests/arrange.mjs that reaches the server’s own machinery: the work ledger, the archive of old turns
// (#305), the person’s ! commands (#67), the checks’ lint turns, the blob store, the server’s delays, and the timers close() clears. tests/arrange.mjs re-exports each helper,
// so tests use them as `arrange.<name>`. Each names what a test needs, so none hands out the object behind it.

import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { sendLint as sendLintOf } from '../server/lint-delivery.mjs';
import { expireStaleCommands as expireStaleCommandsOf } from '../server/shell-runs.mjs';
import { archiveTurns } from '../server/work-archive.mjs';

/** @typedef {import('../server/runtime.mjs').Runtime} Runtime */

// ── The work ledger ──────────────────────────────────────────────────────────────────

/** Adds a record to a conversation’s work, as a turn or a command does. @param {Runtime} rt @param {string} convId @param {object} entry */
export const addWork = (rt, convId, entry) => rt.ledger.add(convId, entry);

/** Changes a work record. @param {Runtime} rt @param {string} convId @param {string} id @param {object} patch */
export const patchWork = (rt, convId, id, patch) => rt.ledger.patch(convId, id, patch);

/** Changes a background job’s record, as its end or its Stop does. @param {Runtime} rt @param {object} job @param {object} change */
export const updateJob = (rt, job, change) => rt.ledger.jobUpdate(job, /** @type {any} */ (change));

/** Has the ledger wait on a record still being written, as a turn’s end does. @param {Runtime} rt @param {Promise<any>} pending */
export const trackWork = (rt, pending) => rt.ledger.track(pending);

/**
 * Records a turn that has ended from its Claude Code stream, through the real stream mapper into the ledger, as the
 * runtime does for a turn on a host, and waits for the ledger to settle.
 * @param {Runtime} rt @param {any} turn @param {object} start  the session, folder and project folder it ran with
 * @param {object[]} events  the stream’s lines, parsed
 */
export async function recordTurn(rt, turn, start, events) {
  const ledger = rt.ledger;
  ledger.startTurn(turn, /** @type {any} */ (start));
  const m = createStreamMapper(
    {
      text() {},
      activity() {},
      status() {},
      compaction() {},
      toolUse: (u) => ledger.toolUse(turn, u),
      toolResult: (r) => ledger.toolResult(turn, r),
      taskEnded: (x) => ledger.taskEnded(turn, x),
      usage: (u) => ledger.usage(turn, u),
    },
    { now: () => Date.now() },
  );
  for (const e of events) m.push(e);
  await ledger.endTurn(turn, { status: 'done' });
  await ledger.idle();
}

/** Records a turn’s end in its work, as the turn’s end does, and resolves once its reply has its line. @param {Runtime} rt @param {any} turn @param {string} status */
export const endWork = (rt, turn, status) => rt.work.endWork(turn, status);

// ── The archive of old turns (#305) ──────────────────────────────────────────────────

/** Whether the archive passes run. @param {Runtime} rt */
export const archiving = (rt) => rt.work.archive.enabled;

/** Turns the archive passes on or off, as config.archiveTurns does. @param {Runtime} rt @param {boolean} on */
export function setArchiving(rt, on) {
  rt.work.archive.enabled = on;
}

/** Runs a conversation’s archive pass, chained behind any running, and returns how many turns it archived. @param {Runtime} rt @param {string} convId */
export const archivePass = (rt, convId) => rt.work.archive.conversation(convId);

/** Runs the pass after start, over every conversation. @param {Runtime} rt */
export const archiveAll = (rt) => rt.work.archiveAll();

/** Waits for a conversation’s archive passes to finish. @param {Runtime} rt @param {string} convId */
export const archiveIdle = (rt, convId) => rt.work.archive.idle(convId);

/** Stops the archive passes, as shutdown does, waiting at most boundMs. @param {Runtime} rt @param {number} [boundMs] */
export const stopArchive = (rt, boundMs) => rt.work.stopArchive(boundMs);

/** Archives a conversation’s older turns once, with nothing running, into the ledger’s blob store. @param {Runtime} rt @param {string} convId */
export const archiveOldTurns = (rt, convId) => archiveTurns({ store: rt.store, blobs: rt.ledger.blobs, convId, running: new Set() });

// ── The person’s ! commands (#67) ─────────────────────────────────────────────────────

/** Where a conversation’s ! commands run, and the host its agent is on, if one. @param {Runtime} rt @param {string} threadId */
export const commandFolder = (rt, threadId) => rt.work.commandFolder(threadId);

/** Starts each ! command’s process with spawn, a fake a test drives. @param {Runtime} rt @param {Function} spawn */
export function withSpawn(rt, spawn) {
  rt.work.spawnShell = /** @type {any} */ (spawn);
}

/** Sends the running commands’ output that waits for its next flush now, so a test needn’t wait for the timer. @param {Runtime} rt */
export const flushCommands = (rt) => rt.work.flushShellOutput();

/** Stops every running command, as shutdown does: SIGINT, then SIGKILL after graceMs. @param {Runtime} rt @param {{ graceMs?: number }} [opts] */
export const stopCommands = (rt, opts) => rt.work.stopAll(opts);

/** Ends the commands a restart left running, as start-up does. @param {Runtime} rt */
export const expireStaleCommands = (rt) => expireStaleCommandsOf(rt.work);

// ── Blobs ────────────────────────────────────────────────────────────────────────────

/** Stores bytes as a blob, as an upload does, and returns its record. @param {Runtime} rt @param {Buffer} bytes */
export const storeBlob = (rt, bytes) => rt.blobs.put(bytes);

/** How many staged blobs are still held. @param {Runtime} rt */
export const heldBlobs = (rt) => rt.blobs.held.size;

/** Where a blob’s bytes are on disk. @param {Runtime} rt @param {string} sha256 */
export const blobPath = (rt, sha256) => rt.blobs.pathOf(sha256);

/** Wraps a blob store’s put in fn, which gets the real put to call or not. */
function wrapPut(blobs, fn) {
  const put = blobs.put.bind(blobs);
  blobs.put = (bytes, opts) => fn(put, bytes, opts);
}

/**
 * Runs each write to the runtime’s blob store, such as a review’s file, through fn, which gets the real write to call
 * or not. @param {Runtime} rt @param {(put: (bytes: Buffer, opts?: any) => Promise<any>, bytes: Buffer, opts?: any) => any} fn
 */
export const onBlobPut = (rt, fn) => wrapPut(rt.blobs, fn);

/**
 * Runs each write to the ledger’s blob store, where the archive passes put old turns, through fn, which gets the real
 * write to call or not. @param {Runtime} rt @param {(put: (bytes: Buffer) => Promise<any>, bytes: Buffer) => any} fn
 */
export const onArchivePut = (rt, fn) => wrapPut(rt.ledger.blobs, fn);

// ── Settings and the timers close() clears ───────────────────────────────────────────

/** One of the server’s settings, as start() set it. @param {Runtime} rt @param {string} key */
export const setting = (rt, key) => rt.config[key];

/** Shortens the server’s delays, such as lintSettleMs, summaryDelayMs or ledgerGraceMs. @param {Runtime} rt @param {Record<string, number>} delays */
export const withDelays = (rt, delays) => Object.assign(rt.config, delays);

/** Arms a lint entry for an agent turn, as the server’s checks do when it ends. @param {Runtime} rt @param {string} turnId @param {object} entry */
export const armLint = (rt, turnId, entry) => rt.lints.set(turnId, entry);

/** Adds a stopped turn’s watchdog timer, which close() must clear. @param {Runtime} rt @param {ReturnType<typeof setTimeout>} timer */
export const addWatchdog = (rt, timer) => rt.watchdogs.add(timer);

/** How many stopped turns’ watchdogs are set. @param {Runtime} rt */
export const watchdogCount = (rt) => rt.watchdogs.size;

// ── The checks (#58) ─────────────────────────────────────────────────────────────────

/** Sends an agent turn’s lint turn once its settle wait is over, as its end does. @param {Runtime} rt @param {string} turnId */
export const sendLint = (rt, turnId) => sendLintOf(rt, turnId);

/** Forgets every lint entry, as a restart does. @param {Runtime} rt */
export const clearLints = (rt) => rt.lints.clear();

/**
 * Adds problems the browser found to an agent turn’s lint turn, and answers whether the agent will hear of them.
 * @param {Runtime} rt @param {string} sessionId @param {string|null|undefined} turnId @param {any[]} problems
 */
export const lint = (rt, sessionId, turnId, problems) => rt.lint(sessionId, turnId, problems);

/** The server’s checks over a finished turn: its problems. @param {Runtime} rt @param {any} turn @param {any} se */
export const checkTurn = (rt, turn, se) => rt.checkTurn(turn, se);

/** Marks the progress steps a turn left running stalled, and answers their problems. @param {Runtime} rt @param {any} turn @param {any} se */
export const stallSteps = (rt, turn, se) => rt.stallSteps(turn, se);

// ── Hosts ────────────────────────────────────────────────────────────────────────────

/** Runs fn as the remote hosts’ manager closes, just before it does. @param {Runtime} rt @param {() => void} fn */
export function onHostsClose(rt, fn) {
  const hosts = /** @type {any} */ (rt.hosts);
  const close = hosts.close.bind(hosts);
  hosts.close = async () => {
    fn();
    await close();
  };
}

/** Whether the runtime has the real host manager, server/remote/hosts.mjs’s, which refreshes. @param {Runtime} rt */
export const realHostManager = (rt) => typeof (/** @type {any} */ (rt.hosts)?.refresh) === 'function';

/** The link to a host, from the runtime’s host manager. @param {Runtime} rt @param {string} hostId */
export const hostLink = (rt, hostId) => /** @type {any} */ (rt.hosts).link(hostId);
