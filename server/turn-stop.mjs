// Stopping a turn: your Stop and its ask about background jobs (#129), what every stop records, the turn's exit that lets
// the session's next turn start (#126), and stopping every turn as Postbox shuts down. Moved from server/runtime.mjs
// (#1236); Runtime keeps a method of each name its callers use, and each function here takes the runtime first.

import * as queue from './message-queue.mjs';
import { arrival } from './queue-batch.mjs';
import { dropScheduledWake, settleScheduledWake } from './scheduled-wakes.mjs';
import { dropWakes } from './side-threads.mjs';
import { newId } from './store.mjs';
import { STORE_STOPPED, whenWritable } from './store-outage.mjs';
import { endSubagent } from './subagent-end.mjs';
import { updateThread } from './thread-write.mjs';
import { endWork } from './turn-end-work.mjs';
import { replyMarks } from './turn-marks.mjs';
import { foldSteps, settleStoppedSteps } from './turn-steps.mjs';

/** How long a stopped turn may hold its session before Postbox lets the next turn start anyway, and says so (#126). */
const STOP_WATCHDOG_MS = 15000;

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
 * @param {{ silent?: boolean, jobs?: 'stop' | 'keep', by?: 'you' | 'shutdown' | 'hung', why?: string, sendNow?: boolean }} [opts]
 */
export function stop(rt, sessionId, { silent = false, jobs = 'stop', by = 'you', why, sendNow = false } = {}) {
  const turn = rt.turns.get(sessionId);
  if (!turn) return false;
  const keep = jobs === 'keep' && !turn.remote ? rt.runningJobs(sessionId, turn.id) : [];
  turn.keepJobs = new Set(keep.map((j) => j.id));
  turn.stopReason = sendNow ? 'send-now' : by === 'shutdown' ? null : keep.length ? 'kept-jobs' : 'stop';
  const ended = { status: 'stopped', stoppedAt: Date.now(), stopReason: turn.stopReason };
  rt.exiting.set(sessionId, { turn, held: [], silent });
  // The adapter reads which jobs to keep from the reason; anything else only sees that the turn was aborted.
  turn.abort.abort(Object.assign(new Error('Stopped by you.'), { name: 'AbortError', keepJobs: keep.map((j) => ({ id: j.id, command: j.command })) }));
  turn.closed = true;
  rt.turns.delete(sessionId);
  rt.recordStopped(turn, ended, { by, why: 'You stopped the agent.' });
  rt.updateSession(sessionId, { state: 'stopping', subagents: [], currentStep: 'Stopping', finishedAt: Date.now(), stopAsk: null });
  // Progress steps running as you keep its jobs running may follow one of them: they run on with it (#129).
  if (keep.length) rt.updateSession(sessionId, { heldSteps: { threadId: turn.threadId, keys: rt.runningProgress(turn.threadId, sessionId) } });
  // Its progress steps still running show as stalled, as at any turn’s end (#98); you stopped it, so no lint turn.
  // Pending, so the heldSteps just written holds its steps behind a held commit too (#1042).
  const se = rt.store.pending.session(sessionId);
  if (se) rt.stallLeftRunning(turn, se, by === 'shutdown' || by === 'hung' ? by : 'stopped');
  if (turn.remote) rt.remote.stopped(turn, { by, why });
  // A process that never exits mustn’t hold the session for good: after a while, the next turn starts anyway.
  setTimeout(() => {
    if (rt.exiting.get(sessionId)?.turn !== turn) return;
    console.error(`@${se?.handle ?? sessionId}’s stopped turn hadn’t ended after ${STOP_WATCHDOG_MS / 1000} s, so its next turn starts anyway.`);
    rt.turnExited(turn);
  }, STOP_WATCHDOG_MS).unref?.();
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
/**
 * What every stop of a turn records, whoever stopped it: your Stop, a shutdown, or the store closing (server/store-outage.mjs).
 * One path, so no way of ending a turn skips a step (gpt’s finding on 1b: a scheduled turn the outage stopped stayed
 * running). A shutdown leaves a scheduled wake due for the restart (#466); every other stop ends it.
 * @param {any} rt  the runtime
 * @param {any} turn @param {{ status: string, stoppedAt: number, stopReason: string | null }} ended
 * @param {{ by: string, why: string }} o  who, and what a waiting permission is told
 */
export function recordStopped(rt, turn, ended, { by, why }) {
  const { sessionId } = turn;
  // Your Stop ends a scheduled wake’s turn for good, so a restart doesn’t run it again; a shutdown leaves it due
  // (#466). A store outage leaves it too: the reload re-arms it as interrupted, its one owner (S1), so settling it
  // here as well would cancel what the agent was told will start again (the integrator’s re-review of #598).
  if (by !== 'shutdown' && by !== 'store') settleScheduledWake(rt, turn, { name: 'AbortError' });
  settleStoppedSteps(rt, turn);
  if (turn.first) foldSteps(rt, turn.threadId, turn.first);
  endWork(rt, turn, 'stopped');
  // A waiting permission is answered no; the card keeps who stopped it, so its note says the person’s stop withdrew
  // it, or that it expired (tellExpired, #721, #853).
  for (const [id, w] of rt.permissionWaits) if (w.sessionId === sessionId) rt.settlePermission(id, 'expired', why, {}, { stoppedBy: by });
  // The open segment by its id, even while it is held behind a commit (its patch follows it in order); then any
  // other segment of this turn still streaming in the visible state (#602).
  let marked = false;
  if (turn.openSegment) {
    rt.patchItem(turn.threadId, turn.openSegment, ended);
    marked = true;
  }
  for (const it of rt.store.pending.items(turn.threadId)) {
    if (it.turnId === turn.id && it.kind === 'agent' && it.status === 'streaming' && it.id !== turn.openSegment) {
      rt.patchItem(turn.threadId, it.id, ended);
      marked = true;
    }
  }
  turn.openSegment = null;
  // The reply always says it was stopped: with no segment still streaming, the stopped reply goes below the last
  // thing the turn showed (#602), on every path that records a stop, the store’s included.
  const se = rt.s.sessions[sessionId];
  if (se && !marked)
    rt.addItem(turn.threadId, {
      kind: 'agent',
      sessionId,
      personaId: se.personaId,
      handle: se.handle,
      turnId: turn.id,
      text: '',
      ...replyMarks(turn),
      ...ended,
    });
}

export function turnExited(rt, turn) {
  // What the exit writes waits for writes to reopen (ST-3), behind the stop’s own records (server/store-outage.mjs).
  if (!rt.store.writable) return whenWritable(rt, () => rt.turnExited(turn));
  rt.settleJobs(turn);
  const ex = rt.exiting.get(turn.sessionId);
  if (ex?.turn !== turn) return;
  rt.exiting.delete(turn.sessionId);
  // From the pending session: Stop's “stopping” may still be held behind a commit as the turn exits (#796).
  const se = rt.store.pending.session(turn.sessionId) ?? rt.s.sessions[turn.sessionId];
  if (!se) return;
  // Something else may have set the state meanwhile (a delete, an answered card); “Stopping” goes either way.
  // A remote turn Postbox stopped because it hung says so instead (#120).
  const hung = se.remoteTurn?.state === 'hung' && se.remoteTurn.rtTurn === turn.id;
  const stoppedBy = turn.stopReason === 'store' ? STORE_STOPPED : hung ? se.remoteTurn.message : 'Stopped by you';
  if (se.state === 'stopping' || se.currentStep === 'Stopping')
    rt.updateSession(se.id, { state: se.state === 'stopping' ? 'idle' : se.state, currentStep: stoppedBy, finishedAt: Date.now(), sideTurn: null });
  else if (se.sideTurn) rt.updateSession(se.id, { sideTurn: null });
  const held = se.retiredFork ? [] : ex.held;
  // Shutting down: your messages wait in their thread’s queue, which a restart keeps, rather than starting a CLI.
  if (rt.closing) {
    for (const h of held.filter((x) => x.message.kind === 'user')) {
      const q = { id: newId('q'), text: h.message.text ?? '', attachments: h.message.attachments ?? [], sessionIds: [se.id], at: Date.now(), seq: arrival() };
      updateThread(rt, h.threadId ?? se.threadId, (t) => ({ queue: [...(t.queue ?? []), q] }));
    }
    return;
  }
  // A silent exit (Send now, which sends only your message, and erase, side threads, host admin and the
  // like) delivers what was held as it is, and the queue waits for that turn’s end. Any other Stop, the person’s, a
  // store outage’s or a hung host turn’s, gives the first turn its thread’s queue, in arrival order, as a turn’s
  // normal end does (#733, #1040).
  if (ex.silent) for (const h of held) rt.deliver(se.id, h.message, { summarizeTo: h.summarizeTo, threadId: h.threadId });
  else rt.takePending(se, { pending: held, threadId: turn.threadId }, true);
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
  const running = turn.remote ? [] : rt.runningJobs(sessionId, turn.id);
  if (running.length && jobs !== 'stop' && jobs !== 'keep') {
    const ask = { jobs: running.length, text: stopAskText(se.handle, running.length), turnId: turn.id };
    rt.updateSession(sessionId, { stopAsk: { ...ask, at: Date.now() } });
    return { ask };
  }
  return { stopped: rt.stop(sessionId, { jobs: jobs === 'keep' ? 'keep' : 'stop' }) };
}

/** You chose not to stop after all: the ask goes away, and the agent carries on. */
export function dismissStopAsk(rt, sessionId) {
  rt.session(sessionId);
  rt.updateSession(sessionId, { stopAsk: null });
}

/**
 * When Postbox shuts down: every turn’s CLI runs in its own process group, and so do the jobs Postbox kept running,
 * so they’d outlive it. Each is stopped, jobs too, and this waits for the turns’ processes to exit, up to graceMs.
 * @param {any} rt  the runtime
 * @param {{ graceMs?: number }} [opts]
 */
export async function stopTurns(rt, { graceMs = 4000 } = {}) {
  rt.closing = true;
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
  // Last: a stopped turn’s end may have queued an archive pass, whose file mustn’t land after the store closes (#305).
  await rt.turnArchive.stop();
}

/** What Postbox asks when you stop an agent whose background jobs are running (#129). */
export function stopAskText(handle, n) {
  return `@${handle} has ${n === 1 ? '1 background job' : `${n} background jobs`} running. Stop ${n === 1 ? 'it' : 'them'} too?`;
}
