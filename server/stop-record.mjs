// What every stop of a turn records, whoever stopped it: your Stop and a shutdown (server/turn-stop.mjs), or the store
// closing (server/store-outage.mjs). Moved from server/turn-stop.mjs, so the outage calls it without an import cycle
// through the runtime (#1442).

import { settleScheduledWake } from './scheduled-wakes.mjs';
import { replyMarks } from './turn-marks.mjs';
import { foldSteps, settleStoppedSteps } from './turn-steps.mjs';

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
  rt.work.endWork(turn, 'stopped');
  // A waiting permission is answered no; the card keeps who stopped it, so its note says the person’s stop withdrew
  // it, or that it expired (tellExpired, #721, #853).
  rt.turnService.asks.expirePermissions(sessionId, why, { stoppedBy: by });
  // The open segment by its id, even while it is held behind a commit (its patch follows it in order); then any
  // other segment of this turn still streaming in the visible state (#602).
  let marked = false;
  if (turn.openSegment) {
    rt.threads.patchItem(turn.threadId, turn.openSegment, ended);
    marked = true;
  }
  for (const it of rt.store.pending.items(turn.threadId)) {
    if (it.turnId === turn.id && it.kind === 'agent' && it.status === 'streaming' && it.id !== turn.openSegment) {
      rt.threads.patchItem(turn.threadId, it.id, ended);
      marked = true;
    }
  }
  turn.openSegment = null;
  // The reply always says it was stopped: with no segment still streaming, the stopped reply goes below the last
  // thing the turn showed (#602), on every path that records a stop, the store’s included.
  const se = rt.s.sessions[sessionId];
  if (se && !marked)
    rt.threads.addItem(turn.threadId, {
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
