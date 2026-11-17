// The end of a turn’s listeners (designs/architecture/services.md, “The end of a turn”): Turns raises `turn.ending`,
// `turn.settled`, `turn.replied`, then `turn.failed` or `turn.ended`, and each concern’s step listens, in the design’s
// order. The composition root adds them before the inbox’s (server/inbox-listeners.mjs), whose listeners run last:
// what the turn took is settled, and what waits for the agent goes next. Functions take the Runtime first, as Turns’
// modules do until the services they reach take its place.

import { fixEnded } from './apps.mjs';
import { settleScheduledWake } from './scheduled-wakes.mjs';
import { postSummary } from './share-back.mjs';
import { endedAs } from './turn-end-work.mjs';
import { needsAfter } from './turn-needs.mjs';

/** Adds the end of a turn’s listeners to the runtime’s bus. @param {any} rt */
export function listenTurnEnd(rt) {
  const { bus } = rt;
  // B, Asks: its permission waits expire while it still counts as running, so their release counts no card tied to a
  // turn; the turn’s end decides those.
  bus.on('turn.ending', ({ turn }) => rt.turnService.asks.expirePermissions(turn.sessionId));
  // E, Delivery: a scheduled wake’s turn settles, with how its host said it ended. F, Work: the turn’s work ends.
  bus.on('turn.settled', ({ turn, err }) => settleScheduledWake(rt, turn, err));
  bus.on('turn.settled', ({ turn, err }) => rt.work.endWork(turn, endedAs(err)));
  // H, Summaries: a turn that went well posts its summary; posted or not, the summary isn’t pending any more, so
  // Summarize back works again, unless one waits behind this turn (#225). Any turn ending clears one a restart left.
  bus.on('turn.replied', ({ turn, se, items, err }) => {
    if (!err) postSummary(rt, se, turn, items);
    rt.clearSummaryPending(turn.threadId, turn);
  });
  // J, Checks: its progress steps still running show as failed, so an error isn’t read as a stall (#98, #664).
  bus.on('turn.failed', ({ turn, se }) => rt.checks.stallLeftRunning(turn, se, 'failed'));
  // M, Apps: an app-check turn that ended without a new version shows the app with a note, or crashed (#964).
  bus.on('turn.ended', ({ turn, se }) => {
    if (turn.kind !== 'app-check') return;
    for (const app of Object.values(rt.store.pending.apps()))
      if (app.sessionId === se.id && app.check.status === 'fixing') rt.store.emit('app', { ...app, check: { ...app.check, status: fixEnded(app) } });
  });
  // N, Asks: what the person needs, the session’s state and unread count, and a notification. What it finds, the
  // listeners after it read.
  bus.on('turn.ended', (end) => Object.assign(end, needsAfter(rt, end.se, end.turn, end.items)));
  // O, Checks: stalled steps, then a lint turn or a quiet lint.
  bus.on('turn.ended', ({ turn, se }) => rt.checks.endTurn(turn, se));
  // P, Threads: a reply in a topic the person isn’t viewing counts there (#228).
  bus.on('turn.ended', ({ turn, open, viewing, topic }) => {
    if (topic && !viewing && (turn.said || open.length)) rt.threads.patch(topic, (x) => ({ unread: (x.unread ?? 0) + 1 }));
  });
  // Q, Summaries: a topic or side thread the turn answered in settles.
  bus.on('turn.ended', ({ turn, se }) => {
    if (turn.threadId !== se.threadId) rt.summaries.settleThread(turn.threadId);
  });
}
