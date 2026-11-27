// Stopping a turn: your Stop and its ask about background jobs (#129), the turn's exit that lets the session's next
// turn start (#126), and stopping every turn as Postbox shuts down. What every stop records is server/stop-record.mjs.
// Moved from server/runtime.mjs (#1236); Runtime keeps a method of each name its callers use, and each function here
// takes the runtime first.

import { runningJobs, runningProgress, settleJobs } from './job-records.mjs';
import * as queue from './message-queue.mjs';
import { clockStopConfirmed } from './run-clock.mjs';
import { dropScheduledWake } from './scheduled-wakes.mjs';
import { dropWakes } from './side-threads.mjs';
import { recordStopped } from './stop-record.mjs';
import { neverReached, STORE_STOPPED, takenBack } from './store-outage.mjs';
import { whenWritable } from './store-wait.mjs';
import { endSubagent } from './subagent-end.mjs';
import { forgetWait } from './turn-transient.mjs';
import { entriesFirst } from './turns.mjs';

/** How long a stopped turn may hold its session before Postbox lets the next turn start anyway, and says so (#126). */
const STOP_WATCHDOG_MS = 15000;

/** What a waiting permission is told, by who stopped the turn: the person, or a run clock (server/run-clock.mjs). */
const STOP_WHY = Object.freeze({
  you: 'You stopped the agent.',
  clock: 'Its run clock reached its budget, so Postbox stopped it.',
  pause: 'The person paused its run clock, so Postbox stopped it until they resume it.',
});

/** What the session’s line says once a turn a run clock stopped has exited, by its stopReason. */
const CLOCK_STOPPED = Object.freeze({ clock: 'Stopped: its run clock reached its budget', pause: 'Stopped: its run clock is paused' });

/**
 * What the session’s line says once a stopped turn has exited: a store that couldn’t save, a remote turn Postbox
 * stopped because it hung (its message), a run clock, or your Stop. @param {any} turn @param {any} se @param {boolean} hung
 */
function stoppedLine(turn, se, hung) {
  if (turn.stopReason === 'store') return STORE_STOPPED;
  if (hung) return se.remoteTurn.message;
  return Object.hasOwn(CLOCK_STOPPED, turn.stopReason) ? CLOCK_STOPPED[/** @type {'clock' | 'pause'} */ (turn.stopReason)] : 'Stopped by you';
}

/**
 * Why a stopped turn’s reply says it stopped (stopReason, app/js/reply-stop.mjs): Send now, a shutdown (none), a run
 * clock’s expiry or pause (#1526), your Stop that kept its background jobs, or your Stop.
 * @param {{ sendNow: boolean, by: string, kept: boolean }} o @returns {string | null}
 */
function stopReasonOf({ sendNow, by, kept }) {
  if (sendNow) return 'send-now';
  if (by === 'shutdown') return null;
  if (by === 'clock' || by === 'pause') return by;
  return kept ? 'kept-jobs' : 'stop';
}

/**
 * Stop ends this agent’s turn and its subagents. Agents it woke keep running. Its process gets SIGINT, then SIGKILL,
 * and the session shows as stopping until it has exited: its next turn waits for that (#126).
 * jobs: what happens to the background jobs the turn started (#129): 'stop' them with it, or 'keep' them running,
 * each with its own Stop.
 * by: 'shutdown' when Postbox stops it as it shuts down, which the agent hears in those words; 'hung' when a remote
 * turn had no output for its host’s stallTimeout (#120), with why: what the person sees. sendNow: your message
 * with Send now stopped it, which its reply says, as it says when you kept its jobs running (#215, #249).
 * A remote turn’s Stop is always a plain stop: the daemon stops the whole turn, so no job is kept (#120).
 * @param {any} rt  the runtime
 * @param {string} sessionId
 * @param {{ silent?: boolean, jobs?: 'stop' | 'keep', by?: 'you' | 'shutdown' | 'hung' | 'clock' | 'pause', why?: string, sendNow?: boolean }} [opts]
 */
export function stop(rt, sessionId, { silent = false, jobs = 'stop', by = 'you', why, sendNow = false } = {}) {
  const turn = rt.turns.get(sessionId);
  if (!turn) return false;
  const keep = jobs === 'keep' && !turn.remote ? runningJobs(rt, sessionId, turn.id) : [];
  turn.keepJobs = new Set(keep.map((j) => j.id));
  turn.stopReason = stopReasonOf({ sendNow, by, kept: keep.length > 0 });
  // Postbox is going: its exit starts nothing, as once it’s closing (turnExited).
  if (by === 'shutdown') turn.shutdown = true;
  const ended = { status: 'stopped', stoppedAt: Date.now(), stopReason: turn.stopReason };
  rt.running.exit(sessionId, { turn, held: [], silent });
  // The adapter reads which jobs to keep from the reason; anything else only sees that the turn was aborted.
  turn.abort.abort(Object.assign(new Error('Stopped by you.'), { name: 'AbortError', keepJobs: keep.map((j) => ({ id: j.id, command: j.command })) }));
  turn.closed = true;
  // Stopped before it reached its agent (store-outage.mjs, neverReached), it gives back what it took, as a failed one
  // does (#1171, #1904).
  if (neverReached(rt, turn)) takenBack(rt, sessionId, turn);
  rt.running.end(sessionId);
  recordStopped(rt, turn, ended, { by, why: by === 'clock' || by === 'pause' ? STOP_WHY[by] : STOP_WHY.you });
  // What the turn took was given to the agent, so it isn't handed over again (designs/architecture/services.md, “The
  // end of a turn”). A shutdown's isn't settled: the restart reopens it once, as a resend.
  if (by !== 'shutdown') rt.bus.emit('turn.stopping', { turn });
  rt.sessions.update(sessionId, { state: 'stopping', subagents: [], currentStep: 'Stopping', finishedAt: Date.now(), stopAsk: null });
  // Progress steps running as you keep its jobs running may follow one of them: they run on with it (#129).
  if (keep.length) rt.sessions.update(sessionId, { heldSteps: { threadId: turn.threadId, keys: runningProgress(rt, turn.threadId, sessionId) } });
  // Its progress steps still running show as stalled, as at any turn’s end (#98); you stopped it, so no lint turn.
  // Pending, so the heldSteps just written holds its steps behind a held commit too (#1042).
  const se = rt.store.pending.session(sessionId);
  if (se) rt.checks.stallLeftRunning(turn, se, by === 'shutdown' || by === 'hung' ? by : 'stopped');
  if (turn.remote) rt.remote.stopped(turn, { by, why });
  // A process that never exits mustn’t hold the session for good: after a while, the next turn starts anyway.
  // Kept in rt.watchdogs, so close() clears it (server/runtime-close.mjs).
  const watchdog = setTimeout(() => {
    rt.watchdogs.delete(watchdog);
    if (rt.exiting.get(sessionId)?.turn !== turn) return;
    console.error(`@${se?.handle ?? sessionId}’s stopped turn hadn’t ended after ${STOP_WATCHDOG_MS / 1000} s, so its next turn starts anyway.`);
    // Its CLI may still work: a run clock voids its run (clockStopConfirmed).
    if (rt.runClock) turn.mayRunOn ??= 'watchdog';
    turnExited(rt, turn);
  }, STOP_WATCHDOG_MS);
  watchdog.unref?.();
  rt.watchdogs.add(watchdog);
  // A stopped summary (or one queued behind the turn, which goes with it) isn’t coming (#93), in a topic thread too.
  // A message from another agent, waiting behind the turn, goes with it: it hears at its next turn what it said.
  rt.clearSummaryPending(turn.threadId);
  for (const p of turn.pending) {
    if (p.summarizeTo && p.threadId) rt.clearSummaryPending(p.threadId);
    // A shutdown leaves it due, for the restart to bring back (rearmWakes), as it does a scheduled turn of its own.
    if (by !== 'shutdown') dropScheduledWake(rt, p.message);
    if (se) queue.rememberStoppedMessages(rt, sessionId, p.message);
  }
  // You stopped it: wakes queued for it go too, and their agents are told (#228). Send now keeps them (silent).
  if (!silent && se) dropWakes(rt, se);
  return true;
}

/**
 * A turn’s adapter is done, which for a real backend means its process has exited. Its background jobs that nothing
 * reported the end of went with it, and a stopped session takes what waited for it: the messages sent meanwhile,
 * then the queue.
 */
export function turnExited(rt, turn) {
  // With run clocks on, a clock that paused or expired while this turn could still work hears it’s over, at the time it
  // was, or that Postbox stopped waiting for a CLI that may still work (mayRunOn: the watchdog, or a group that
  // outlived SIGKILL).
  if (rt.runClock && !turn.remote) clockStopConfirmed(rt, turn.sessionId, `turn:${turn.id}`, Date.now(), turn.mayRunOn);
  // What the exit writes waits for writes to reopen (ST-3), behind the stop’s own records (server/store-outage.mjs).
  if (!rt.store.writable) return whenWritable(rt, () => turnExited(rt, turn));
  settleJobs(rt, turn);
  const ex = rt.exiting.get(turn.sessionId);
  if (ex?.turn !== turn) return;
  rt.running.exited(turn.sessionId);
  // From the pending session: Stop's “stopping” may still be held behind a commit as the turn exits (#796).
  const se = rt.store.pending.session(turn.sessionId) ?? rt.s.sessions[turn.sessionId];
  if (!se) return;
  // Something else may have set the state meanwhile (a delete, an answered card); “Stopping” goes either way.
  // A remote turn Postbox stopped because it hung says so instead (#120).
  const hung = se.remoteTurn?.state === 'hung' && se.remoteTurn.rtTurn === turn.id;
  const stoppedBy = stoppedLine(turn, se, hung);
  // A stopped turn ends a wait to try a provider’s failure again, and its count (#1713).
  forgetWait(rt, se.id);
  if (se.state === 'stopping' || se.currentStep === 'Stopping')
    rt.sessions.update(se.id, {
      state: se.state === 'stopping' ? 'idle' : se.state,
      currentStep: stoppedBy,
      finishedAt: Date.now(),
      sideTurn: null,
    });
  else if (se.sideTurn) rt.sessions.update(se.id, { sideTurn: null });
  const held = se.retiredFork ? [] : ex.held;
  // Shutting down, nothing starts a CLI: your messages wait in the agent’s inbox, which a restart keeps. One a turn took
  // from it (Send now’s) stays taken, and the restart reopens it once (Delivery’s start), so it isn’t posted again
  // (#1108); one held without an entry gets one, for its item, or with its own text when it has none.
  if (rt.closing || turn.shutdown) {
    for (const h of held.filter((x) => x.message.kind === 'user' && !x.message.fromEntries)) {
      const said = h.message.itemId ? { itemId: h.message.itemId } : { text: String(h.message.text ?? '') };
      rt.delivery.send({ ...said, sessionId: se.id, threadId: h.threadId ?? se.threadId, source: 'person', from: 'you' }, { wake: false });
    }
    return;
  }
  // A silent exit (Send now, which sends only your message, and erase, side threads, host admin and the
  // like) delivers what was held as it is, and the agent’s entries wait for that turn’s end. Any other Stop, the
  // person’s, a store outage’s or a hung host turn’s, gives the first turn its thread’s entries, in arrival order, as a
  // turn’s normal end does (#733, #1040).
  if (ex.silent) for (const h of held) rt.turnService.release(se.id, h.message, { summarizeTo: h.summarizeTo, threadId: h.threadId });
  else {
    // What arrived first goes first: an entry that came before everything held starts its turn, and the held messages
    // wait on it (#733).
    const ended = { pending: held, threadId: turn.threadId };
    if (entriesFirst(rt, se, ended)) rt.delivery.wake(se.id);
    queue.takePending(rt, se, ended, true);
  }
  // The stopped turn is gone: what waits for the agent may start its next turn.
  rt.bus.emit('turn.exited', { turn });
}

/**
 * Stop from the page (#129): with background jobs running, it asks first whether to stop them too, and the ask
 * shows in the conversation (se.stopAsk) until you answer, dismiss it, or the turn ends.
 * turnId: the turn the ask was about. An answer to an ask about a turn that has ended since stops nothing.
 * subagent: End on that subagent’s row instead (#229), which tells the agent to stop it.
 * @param {any} rt  the runtime
 * @param {string} sessionId @param {{ jobs?: 'stop' | 'keep' | null, turnId?: string | null, subagent?: string | null }} [choice]
 */
export function requestStop(rt, sessionId, { jobs = null, turnId = null, subagent = null } = {}) {
  if (subagent) return endSubagent(rt, sessionId, String(subagent));
  const se = rt.session(sessionId);
  const turn = rt.turns.get(sessionId);
  if (!turn) return { stopped: false };
  if (turnId && turnId !== turn.id) return { stopped: false, ended: true };
  // A remote turn’s jobs stop with it (#120), so there’s nothing to ask.
  const running = turn.remote ? [] : runningJobs(rt, sessionId, turn.id);
  if (running.length && jobs !== 'stop' && jobs !== 'keep') {
    const ask = { jobs: running.length, text: stopAskText(se.handle, running.length), turnId: turn.id };
    rt.sessions.update(sessionId, { stopAsk: { ...ask, at: Date.now() } });
    return { ask };
  }
  return { stopped: rt.stop(sessionId, { jobs: jobs === 'keep' ? 'keep' : 'stop' }) };
}

/** You chose not to stop after all: the ask goes away, and the agent carries on. */
export function dismissStopAsk(rt, sessionId) {
  rt.session(sessionId);
  rt.sessions.update(sessionId, { stopAsk: null });
}

/**
 * When Postbox shuts down: every turn’s CLI runs in its own process group, and so do the jobs Postbox kept running,
 * so they’d outlive it. Each is stopped, jobs too, and this waits for the turns’ processes to exit, up to graceMs.
 * @param {any} rt  the runtime
 * @param {{ graceMs?: number }} [opts]
 */
export async function stopTurns(rt, { graceMs = 4000 } = {}) {
  rt.running.close();
  // A turn on a remote host doesn’t need Postbox: it goes on there, and is attached again after the restart (#120).
  // A stop that fails is logged, and the others still happen: one turn’s failure mustn’t leave the other turns’ CLIs,
  // the hosts’ link or the kept jobs running.
  const failed = (what, e) => console.error(`Postbox couldn’t stop ${what} cleanly as it shut down: ${e.message}`);
  for (const [id, turn] of [...rt.turns]) {
    if (turn.remote) continue;
    try {
      rt.stop(id, { silent: true, by: 'shutdown' });
    } catch (e) {
      failed(`the turn of session ${id}`, e);
    }
  }
  try {
    rt.remote.close();
  } catch (e) {
    failed('the hosts’ link', e);
  }
  await rt.stopKeptJobs(Object.keys(rt.s.sessions), 'Postbox stopped it as it shut down.').catch((e) => failed('the background jobs it kept running', e));
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  const late = new Promise((r) => {
    timer = setTimeout(r, graceMs);
  });
  await Promise.race([Promise.all([...rt.exiting.values()].map((x) => x.turn.exited)), late]);
  clearTimeout(timer);
  // A deleted agent’s memory waits for its stopped turn to exit (#1797). Postbox waits no longer, so its forget starts
  // now, unawaited: a turn that never exits would otherwise keep that memory on disk for good.
  rt.running.releaseWaits();
  // Last: a stopped turn’s end may have queued an archive pass, whose file mustn’t land after the store closes (#305).
  await rt.work.stopArchive();
}

/** What Postbox asks when you stop an agent whose background jobs are running (#129). */
export function stopAskText(handle, n) {
  return `@${handle} has ${n === 1 ? '1 background job' : `${n} background jobs`} running. Stop ${n === 1 ? 'it' : 'them'} too?`;
}
