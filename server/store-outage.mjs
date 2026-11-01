// Turns while the store can’t be written (#508’s storage design, “When a write fails (ST-3)”; the 1b invariants, I1 and
// I3). When writes close (a write or fsync of the log failed, server/store-retry.mjs), Postbox:
// - stops every running turn at once, in memory: its agent is told to stop, saying why, and nothing more it says is
//   taken. What the stop writes (its reply marked stopped by the store, its steps settled, the session idle) waits
//   until writes reopen, as does what the turn’s exit writes, because an emit made while the store is closed reaches
//   memory and the page but not the disk, and Retry’s reload discards it;
// - starts no turn: a turn that would start (a wake, a queued message, a scheduled wake) waits, in order, and starts
//   once writes reopen. Your own messages can’t be posted meanwhile (the router refuses the write with the cause), so
//   only what Postbox itself would start waits here;
// - keeps a backend’s session id, the latest per session, and saves it once writes reopen, before any turn that
//   waited, so the next turn resumes that session.
// Reopening is Retry (server/store-retry.mjs): the store installs the recovered state and tells its status listeners,
// and only then does what waited run, so no reconciled work starts before the durability barrier has passed (I3);
// on Linux that barrier proves only that no new writeback error occurred (storage-design 6.6). What waited is the work
// the reload doesn’t recreate: an entry owned by a timer is dropped at the reload, whose re-arm is its one owner (S1).
// A restart while the store is closed starts again from what the disk holds, as any restart does.

import { rearmPersonaDeletes } from './persona-delete.mjs';
import { rearmWakes } from './scheduled-wakes.mjs';

/** @typedef {import('./runtime.mjs').Runtime} Runtime */

/** What a reply stopped by the outage says, and what the stopped agent is told. */
export const STORE_STOPPED = 'Stopped: Postbox couldn’t save changes';
const WHY = 'Postbox stopped this turn because it can’t save changes right now. It will start again once it can.';

/** Starts watching the store: writes closing stop the turns, and reopening runs what waited. @param {Runtime} rt */
export function watchStore(rt) {
  let was = rt.store.writable;
  rt.store.onStatus((status) => {
    if (status.writable === was) return;
    was = status.writable;
    try {
      if (status.writable) reopened(rt);
      else for (const id of [...rt.turns.keys()]) stopForStore(rt, id);
    } catch (e) {
      // A listener runs inside the store’s writer: an error here must not end Postbox.
      console.error(`Postbox couldn’t handle the store’s change: ${e instanceof Error ? e.stack : e}`);
    }
  });
  // Retry installed a recovered state: every schedule timer was armed under the old one, so none of them acts (gpt’s
  // finding: an old timer fired a wake the recovered state didn’t hold); they are re-armed from what the disk held,
  // as a restart does, with a wake caught running marked interrupted (rearmWakes). This runs before reopened(): the
  // store tells its reload listeners before its status listeners hear writes reopen (server/store-retry.mjs).
  // Every timer in rt.timers is re-armed, the deletions too (the integrator’s finding on 1b: a purge whose Undo window
  // ended during the outage had fired, done nothing durable, and left the thread “deleting” with no timer).
  rt.store.onReload(() => {
    dropOwned(rt); // before the re-arm: the timers below are now the only owners of what they recreate
    for (const timer of rt.timers.values()) clearTimeout(timer);
    rt.timers.clear();
    rearmWakes(rt);
    rt.rearmDeletions();
    rearmPersonaDeletes(rt);
  });
}

/**
 * The one rule for a runtime timer whose callback writes to the store or kills a process: while writes are closed it
 * waits for them to reopen (whenWritable) instead of running or being lost. A timer re-armed at Retry fires during
 * reconciliation, when writes are still closed (critic’s and gpt’s condition on the sweep): deferring, not dropping,
 * is what makes an overdue purge run once writes reopen. A poller, by contrast, skips its tick and catches up at the
 * next one. Returns whether fn ran now. owner: as whenWritable’s, for a timer the reload re-arms.
 * @param {Runtime} rt @param {() => unknown} fn @param {{ owner?: string }} [o]
 */
export function gated(rt, fn, { owner } = {}) {
  if (rt.store.writable) {
    fn();
    return true;
  }
  whenWritable(rt, fn, { owner });
  return false;
}

/**
 * Runs fn now if the store takes writes, else once it does. first: before what already waits, for a write any later
 * turn depends on, such as a backend’s session id. owner: the timer that would recreate this work from the recovered
 * state (a wake’s schedule id, a purge’s `del:`/`delt:`/`delp:` key); the reload drops owned entries before it re-arms,
 * so each unit of work has one owner after Retry (S1, the integrator’s re-review of #598: a wake fired while closed was
 * delivered twice). @param {Runtime} rt @param {() => void} fn @param {{ first?: boolean, owner?: string }} [o]
 */
export function whenWritable(rt, fn, { first = false, owner } = {}) {
  if (rt.store.writable) return fn();
  const entry = owner ? Object.assign(() => fn(), { owner }) : fn;
  if (first) rt.storeWait.unshift(entry);
  else rt.storeWait.push(entry);
}

/** Drops the held work a reload recreates from the recovered state: every entry with an owner (S1). @param {Runtime} rt */
function dropOwned(rt) {
  for (let i = rt.storeWait.length - 1; i >= 0; i--) if (/** @type {any} */ (rt.storeWait[i]).owner) rt.storeWait.splice(i, 1);
}

/**
 * Saves what an adapter keeps for its session, such as the backend’s own session id. While the store can’t be written,
 * the saves for a session merge into one, the latest value per field winning, which is written once it can, before any
 * turn that waited, so the next turn resumes that session.
 * @param {Runtime} rt @param {string} sessionId @param {Record<string, any>} patch
 */
export function saveBackendState(rt, sessionId, patch) {
  const waiting = rt.backendWait.get(sessionId);
  if (waiting) return void Object.assign(waiting, patch);
  if (rt.store.writable) return writeBackendState(rt, sessionId, patch);
  const merged = { ...patch };
  rt.backendWait.set(sessionId, merged);
  whenWritable(
    rt,
    () => {
      rt.backendWait.delete(sessionId);
      writeBackendState(rt, sessionId, merged);
    },
    { first: true },
  );
}

/** @param {Runtime} rt @param {string} sessionId @param {Record<string, any>} patch */
function writeBackendState(rt, sessionId, patch) {
  const se = rt.s.sessions[sessionId];
  if (se) rt.updateSession(sessionId, { backendState: { ...(se.backendState ?? {}), ...patch } });
}

/** Runs what waited for writes, in order, while they stay open. @param {Runtime} rt */
function reopened(rt) {
  while (rt.storeWait.length && rt.store.writable) {
    const fn = /** @type {() => void} */ (rt.storeWait.shift());
    try {
      fn();
    } catch (e) {
      console.error(`Postbox couldn’t finish what waited for the store: ${e instanceof Error ? e.stack : e}`);
    }
  }
}

/**
 * A turn that can’t start because the store can’t be written: it waits, and starts once writes reopen. Returns whether
 * it waits. @param {Runtime} rt @param {string} sessionId @param {() => void} start
 */
export function heldTurn(rt, sessionId, start) {
  if (rt.store.writable) return false;
  console.error(`@${rt.s.sessions[sessionId]?.handle ?? sessionId}’s turn waits: Postbox can’t save changes right now.`);
  rt.storeWait.push(start);
  return true;
}

/** Stops a running turn because writes closed: in memory now, its records once writes reopen. @param {Runtime} rt @param {string} sessionId */
function stopForStore(rt, sessionId) {
  const turn = rt.turns.get(sessionId);
  if (!turn) return;
  turn.stopReason = 'store';
  // What waited behind it goes once it has exited and writes are open again, as after any Stop.
  rt.exiting.set(sessionId, { turn, held: turn.pending.splice(0), silent: false });
  turn.abort.abort(Object.assign(new Error(WHY), { name: 'AbortError' }));
  turn.closed = true;
  rt.turns.delete(sessionId);
  console.error(`@${rt.s.sessions[sessionId]?.handle ?? sessionId}’s turn stopped: Postbox can’t save changes right now.`);
  rt.storeWait.push(() => recordStop(rt, turn));
}

/** What a Stop writes, for a turn the outage stopped, once writes reopen: the one path every stop takes. @param {Runtime} rt @param {any} turn */
function recordStop(rt, turn) {
  const { sessionId } = turn;
  const ended = { status: 'stopped', stoppedAt: Date.now(), stopReason: 'store' };
  rt.recordStopped(turn, ended, { by: 'store', why: WHY });
  const se = rt.s.sessions[sessionId];
  if (!se) return;
  // Its process may not have exited yet: the session reads as stopping until it has (turnExited).
  if (rt.exiting.get(sessionId)?.turn === turn)
    rt.updateSession(sessionId, { state: 'stopping', subagents: [], currentStep: 'Stopping', finishedAt: Date.now(), stopAsk: null });
  rt.stallLeftRunning(turn, se, 'stopped');
  if (turn.remote) rt.remote.stopped(turn, { by: 'you', why: WHY });
  rt.clearSummaryPending(turn.threadId);
}
