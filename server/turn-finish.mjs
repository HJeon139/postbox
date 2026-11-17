// A turn's end: what it leaves on its replies and the session, and a failed reply with its Retry. Each other
// concern's step listens to the signals it raises, in order (designs/architecture/services.md, “The end of a turn”;
// server/turn-end-listeners.mjs, then server/inbox-listeners.mjs). Moved from server/runtime.mjs (#1236). Named for
// finishing a turn: turn-end-work.mjs is only its work ledger's end.

import { emptyReply, endedWithoutReply } from './empty-reply.mjs';
import { askedOf, replyMarks } from './turn-marks.mjs';
import { foldSteps } from './turn-steps.mjs';

/**
 * A turn ended, with err when it failed or was stopped: it leaves the running turns, its replies and the session show
 * how it ended, and what waited for it goes next.
 * @param {any} rt  the runtime @param {any} turn @param {any} err
 */
export function endTurn(rt, turn, err) {
  if (turn.closed) return;
  turn.closed = true;
  // Raised while it still counts as running: its permission waits expire then.
  rt.bus.emit('turn.ending', { turn });
  rt.running.end(turn.sessionId);
  rt.settleSubagentSteps(turn);
  // Its steps fold to what its record keeps: the live view's detail goes with the turn (turn-steps.mjs).
  if (turn.first) foldSteps(rt, turn.threadId, turn.first);
  // How a remote turn ended on its host decides what the person sees: Sign-in needed and Interrupted say so (#120).
  if (turn.remote) err = rt.remote.ended(turn, err);
  rt.bus.emit('turn.settled', { turn, err });
  // The turn’s own lines in an attached session’s transcript aren’t terminal activity.
  rt.mirrors.get(turn.sessionId)?.tail.skipToEnd();
  const se = rt.s.sessions[turn.sessionId];
  if (!se) return;
  const items = rt.store.pending.items(turn.threadId);
  // A turn that ends with no reply is never posted as an empty message (#485, empty-reply.mjs): it fails, saying so.
  if (!err && endedWithoutReply(turn, items)) err = emptyReply(rt, se, turn);
  // How it ended, for the entries its replies’ mentions make as they settle (mention-entries.mjs).
  turn.endErr = err;
  settleReplies(rt, turn, items, err);
  rt.bus.emit('turn.replied', { turn, se, items, err });
  if (err && err.name !== 'AbortError') {
    endFailed(rt, se, turn, err);
    return;
  }
  // The listeners share what the person needs (open, viewing, topic): Asks’ listener (N) writes it, and those after it read it.
  rt.bus.emit('turn.ended', { turn, se, items, open: [], viewing: false, topic: null });
}

/**
 * The turn's replies show how it ended: its open part and any other still streaming are done or failed, and a turn
 * that went well marks its checkpoint. @param {any} rt @param {any} turn @param {any[]} items @param {any} err
 */
function settleReplies(rt, turn, items, err) {
  // The open segment by its id, even while held behind a commit; then any other still streaming in the visible state.
  if (turn.openSegment) rt.threads.patchItem(turn.threadId, turn.openSegment, { status: err ? 'failed' : 'done' });
  for (const it of items)
    if (it.turnId === turn.id && it.kind === 'agent' && it.status === 'streaming' && it.id !== turn.openSegment)
      rt.threads.patchItem(turn.threadId, it.id, { status: err ? 'failed' : 'done' });
  turn.openSegment = null;
  if (turn.checkpoint && !err)
    for (const it of items)
      if (it.turnId === turn.id && (it.kind === 'agent' || it.kind === 'block')) rt.threads.patchItem(turn.threadId, it.id, { checkpoint: turn.checkpoint });
}

/**
 * A turn that failed: its reply says so, with Retry; the session needs the person; and the agents it mentioned, and
 * the wakes that waited for it, still go.
 * @param {any} rt @param {any} se @param {any} turn @param {any} err
 */
function endFailed(rt, se, turn, err) {
  const message = err.userMessage ?? err.message ?? 'The agent stopped unexpectedly.';
  const target =
    turn.segment ??
    turn.first ??
    rt.threads.addItem(turn.threadId, {
      kind: 'agent',
      sessionId: se.id,
      personaId: se.personaId,
      handle: se.handle,
      turnId: turn.id,
      text: '',
      status: 'failed',
      ...replyMarks(turn),
    }).id;
  rt.threads.patchItem(turn.threadId, target, {
    status: 'failed',
    error: message,
    retry: turn.retry ?? null,
    asked: askedOf(turn),
    ...(err.remote ? { remote: err.remote } : {}),
    ...(err.rawEnding ? { rawEnding: err.rawEnding } : {}),
  });
  rt.sessions.update(se.id, {
    state: 'failed',
    needs: { kind: 'failed', itemId: target, text: message, ...rt.sessions.awayFrom(se, turn.threadId) },
    sideTurn: null,
    subagents: [],
    currentStep: 'Failed',
    finishedAt: Date.now(),
    stopAsk: null,
  });
  rt.threads.notify('blocking', se, `@${se.handle}’s reply failed`, message, turn.threadId);
  // Its @-mentions still reach their agents (#485, the person’s choice), as entries its replies made as they settled,
  // read with the failure first, since what it wrote may be cut off (turns.mjs). Not a host turn that goes on
  // (Interrupted, Sign-in needed, its link lost): its replay’s replies make them (mention-entries.mjs). The item keeps
  // whom they reached, with those the failures before it reached, so no Retry hands the work over again.
  const woke = turn.mentioned ?? [];
  if (woke.length || turn.woken.length) rt.threads.patchItem(turn.threadId, target, { wokeOnFailure: [...new Set([...turn.woken, ...woke])] });
  // Last: its progress steps stall, what waited for it and what it took settle, and the agents its replies mentioned
  // are woken.
  rt.bus.emit('turn.failed', { turn, se });
}
