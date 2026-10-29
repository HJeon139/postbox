// Turns while the store can’t be written (#508’s requirements, ST-3; design 6.6, decision 7). When writes close
// (Redis died, a write failed, or the store is reading Redis back), Postbox:
// - stops every running turn at once, in memory: its agent is told to stop, saying why, and nothing more it says is
//   taken. What the stop writes (its reply marked stopped by the store, its steps settled, the session idle) waits
//   until writes reopen, as does what the turn’s exit writes;
// - starts no turn: a turn that would start (a wake, a queued message, a scheduled wake) waits, in order, and starts
//   once writes reopen. Your own messages can’t be posted meanwhile (the page’s write is refused with the cause), so
//   only what Postbox itself would start waits here;
// - keeps what an agent’s stream or a timer would write from throwing out of its listener, which would end Postbox:
//   a backend’s session id is kept and saved once writes reopen, and the rest waits or is dropped where it’s redundant.
// The waits are in memory: a restart while the store is down starts again from what Redis holds, as any restart does.
// Records of who was told what (design step A2) replace this with records that go back to waiting.

import { settleStoppedSteps } from './turn-steps.mjs';

/** @typedef {import('./runtime.mjs').Runtime} Runtime */

/** What a reply stopped by the outage says, and what the stopped agent is told. */
export const STORE_STOPPED = 'Stopped: Postbox couldn’t save changes';
const WHY = 'Postbox stopped this turn because it can’t save changes while its store is down. It will start again once the store is back.';

/** Starts watching the store: writes closing stop the turns, and reopening runs what waited. @param {Runtime} rt */
export function watchStore(rt) {
  rt.store.watchers?.add((/** @type {boolean} */ writable) => {
    try {
      if (writable) reopened(rt);
      else for (const id of [...rt.turns.keys()]) stopForStore(rt, id);
    } catch (e) {
      // A watcher runs in the store’s connection and child listeners: an error here must not end Postbox.
      console.error(`Postbox couldn’t handle the store’s change: ${e instanceof Error ? e.stack : e}`);
    }
  });
}

/**
 * Runs fn now if the store takes writes, else once it does. first: before what already waits, for a write any later
 * turn depends on, such as a backend’s session id. @param {Runtime} rt @param {() => void} fn
 */
export function whenWritable(rt, fn, { first = false } = {}) {
  if (rt.store.writable) return fn();
  if (first) rt.storeWait.unshift(fn);
  else rt.storeWait.push(fn);
}

/**
 * Saves what an adapter keeps for its session, such as the backend’s own session id. While the store can’t be written,
 * it’s saved once it can, before any turn that waited, so the next turn resumes that session.
 * @param {Runtime} rt @param {string} sessionId @param {Record<string, any>} patch
 */
export function saveBackendState(rt, sessionId, patch) {
  whenWritable(
    rt,
    () => {
      const se = rt.s.sessions[sessionId];
      if (se) rt.updateSession(sessionId, { backendState: { ...(se.backendState ?? {}), ...patch } });
    },
    { first: true },
  );
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
  console.error(`@${rt.s.sessions[sessionId]?.handle ?? sessionId}’s turn waits: Postbox can’t save changes while its store is down.`);
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
  console.error(`@${rt.s.sessions[sessionId]?.handle ?? sessionId}’s turn stopped: Postbox can’t save changes while its store is down.`);
  rt.storeWait.push(() => recordStop(rt, turn));
}

/** What a Stop writes, for a turn the outage stopped, once writes reopen. @param {Runtime} rt @param {any} turn */
function recordStop(rt, turn) {
  const { sessionId } = turn;
  const ended = { status: 'stopped', stoppedAt: Date.now(), stopReason: 'store' };
  settleStoppedSteps(rt, turn);
  rt.endWork(turn, 'stopped');
  for (const [id, w] of rt.permissionWaits) if (w.sessionId === sessionId) rt.settlePermission(id, 'expired', WHY);
  for (const it of rt.store.items(turn.threadId))
    if (it.turnId === turn.id && it.kind === 'agent' && it.status === 'streaming') rt.patchItem(turn.threadId, it.id, ended);
  const se = rt.s.sessions[sessionId];
  if (!se) return;
  if (!turn.segment && !turn.first)
    rt.addItem(turn.threadId, { kind: 'agent', sessionId, personaId: se.personaId, handle: se.handle, turnId: turn.id, text: '', ...ended });
  // Its process may not have exited yet: the session reads as stopping until it has (turnExited).
  if (rt.exiting.get(sessionId)?.turn === turn)
    rt.updateSession(sessionId, { state: 'stopping', subagents: [], currentStep: 'Stopping', finishedAt: Date.now(), stopAsk: null });
  rt.stallLeftRunning(turn, se, 'stopped');
  if (turn.remote) rt.remote.stopped(turn, { by: 'you', why: WHY });
  rt.clearSummaryPending(turn.threadId);
}

/**
 * The turn’s context, with each callback kept from throwing ESTOREDOWN out of the adapter’s listener: writes close in
 * the same tick the store hears of it, so a callback that writes after that finds its turn stopped, and anything left
 * that throws ESTOREDOWN is dropped with a line in the log. @param {any} ctx
 */
export function guardContext(ctx) {
  for (const [k, fn] of Object.entries(ctx))
    if (typeof fn === 'function')
      ctx[k] = (/** @type {any[]} */ ...a) => {
        try {
          return fn(...a);
        } catch (e) {
          if (/** @type {any} */ (e)?.code !== 'ESTOREDOWN') throw e;
          console.error(`Postbox didn’t save an agent’s ${k} while its store is down: ${/** @type {Error} */ (e).message}`);
        }
      };
  return ctx;
}
