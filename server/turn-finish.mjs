// A turn's end: what it leaves on its replies and the session, a failed reply with its Retry, what the person needs
// and is told, the checks that go back to the agent, and the wakes and messages that waited for it. Moved from
// server/runtime.mjs (#1236). Named for finishing a turn: turn-end-work.mjs is only its work ledger's end.

import { ASKING } from '../shared/catalog.mjs';
import { fixEnded } from './apps.mjs';
import { nextNeed, noticeNeed, stateFor } from './card-needs.mjs';
import { emptyReply, endedWithoutReply } from './empty-reply.mjs';
import { clip } from './helpers.mjs';
import { settleScheduledWake } from './scheduled-wakes.mjs';
import { postSummary } from './share-back.mjs';
import { settleThread } from './thread-summary.mjs';
import { updateThread } from './thread-write.mjs';
import { endedAs, endWork } from './turn-end-work.mjs';
import { askedOf, replyMarks } from './turn-marks.mjs';
import { foldSteps } from './turn-steps.mjs';

export function endTurn(rt, turn, err) {
  if (turn.closed) return;
  turn.closed = true;
  // Its permissions expire while it still counts as running, so their release counts no card tied to a turn: the
  // turn's end, below, decides those.
  for (const [id, w] of rt.permissionWaits) if (w.sessionId === turn.sessionId) rt.settlePermission(id, 'expired');
  rt.turns.delete(turn.sessionId);
  rt.settleSubagentSteps(turn);
  // Its steps fold to what its record keeps: the live view's detail goes with the turn (turn-steps.mjs).
  if (turn.first) foldSteps(rt, turn.threadId, turn.first);
  // How a remote turn ended on its host decides what the person sees: Sign-in needed and Interrupted say so (#120).
  if (turn.remote) err = rt.remote.ended(turn, err);
  settleScheduledWake(rt, turn, err);
  endWork(rt, turn, endedAs(err));
  // The turn’s own lines in an attached session’s transcript aren’t terminal activity.
  rt.mirrors.get(turn.sessionId)?.tail.skipToEnd();
  const se = rt.s.sessions[turn.sessionId];
  if (!se) return;
  const items = rt.store.pending.items(turn.threadId);
  // A turn that ends with no reply is never posted as an empty message (#485, empty-reply.mjs): it fails, saying so.
  if (!err && endedWithoutReply(turn, items)) err = emptyReply(rt, se, turn);
  // The open segment by its id, even while held behind a commit; then any other still streaming in the visible state.
  if (turn.openSegment) rt.patchItem(turn.threadId, turn.openSegment, { status: err ? 'failed' : 'done' });
  for (const it of items)
    if (it.turnId === turn.id && it.kind === 'agent' && it.status === 'streaming' && it.id !== turn.openSegment)
      rt.patchItem(turn.threadId, it.id, { status: err ? 'failed' : 'done' });
  turn.openSegment = null;
  if (turn.checkpoint && !err)
    for (const it of items)
      if (it.turnId === turn.id && (it.kind === 'agent' || it.kind === 'block')) rt.patchItem(turn.threadId, it.id, { checkpoint: turn.checkpoint });
  if (!err) postSummary(rt, se, turn, items);
  // Posted or not, the summary isn’t pending any more, so Summarize back works again, unless one waits behind this
  // turn (#225). Any turn ending clears one a restart left behind, too.
  rt.clearSummaryPending(turn.threadId, turn);
  if (err && err.name !== 'AbortError') {
    // Its progress steps still running show as stalled, as at any turn’s end (#98).
    rt.stallLeftRunning(turn, se, 'failed');
    const message = err.userMessage ?? err.message ?? 'The agent stopped unexpectedly.';
    const target =
      turn.segment ??
      turn.first ??
      rt.addItem(turn.threadId, {
        kind: 'agent',
        sessionId: se.id,
        personaId: se.personaId,
        handle: se.handle,
        turnId: turn.id,
        text: '',
        status: 'failed',
        ...replyMarks(turn),
      }).id;
    rt.patchItem(turn.threadId, target, {
      status: 'failed',
      error: message,
      retry: turn.retry ?? null,
      asked: askedOf(turn),
      ...(err.remote ? { remote: err.remote } : {}),
      ...(err.rawEnding ? { rawEnding: err.rawEnding } : {}),
    });
    rt.updateSession(se.id, {
      state: 'failed',
      needs: { kind: 'failed', itemId: target, text: message, ...rt.awayFrom(se, turn.threadId) },
      sideTurn: null,
      subagents: [],
      currentStep: 'Failed',
      finishedAt: Date.now(),
      stopAsk: null,
    });
    rt.notify('blocking', se, `@${se.handle}’s reply failed`, message, turn.threadId);
    // Its @-mentions still wake their agents (#485, the person’s choice): what it wrote may be cut off, so they’re told.
    // Not a host turn that goes on (Interrupted, Sign-in needed, its link lost): it wakes them when it ends.
    // The item keeps whom they woke, with those the failures before it woke, so no Retry wakes them again.
    const wakes = turn.said.trim() && !err.remote && se.remoteTurn?.state !== 'lost';
    const woke = wakes ? rt.wakeMentions(se, turn, `(This reply failed before it finished: ${message} It may be cut off.)\n\n${turn.said}`) : [];
    if (woke.length || turn.woken.length) rt.patchItem(turn.threadId, target, { wokeOnFailure: [...new Set([...turn.woken, ...woke])] });
    // A wake that waited for this turn still goes: with no forks, it was promised an answer (#228). Your own
    // queued messages wait, as before, for you to see the failure.
    rt.takePending(se, turn, 'wakes');
    return;
  }
  // An app-check turn that ended without a new version: show the app with a note, or crashed (#964), not wait forever.
  if (turn.kind === 'app-check') {
    for (const app of Object.values(rt.store.pending.apps()))
      if (app.sessionId === se.id && app.check.status === 'fixing') rt.store.emit('app', { ...app, check: { ...app.check, status: fixEnded(app) } });
  }
  // Only this turn’s asking blocks make the agent need you. Older ones you left open stay open, and the
  // client shows them quietly (“1 open review”), so moving on clears needs-you (#69). A turn you didn’t start
  // (a lint or app-check pass, another agent’s wake or review) isn’t moving on: the block it was waiting on still counts.
  const open = items.filter(
    (it) => it.kind === 'block' && it.turnId === turn.id && it.sessionId === se.id && it.valid && ASKING.has(it.block.type) && !it.answered,
  );
  const waiting = se.keptId ? items.find((it) => it.id === se.keptId) : null;
  if (!open.length && waiting && !waiting.answered) open.push(waiting);
  const last = [...items].reverse().find((it) => it.kind === 'agent' && it.sessionId === se.id && it.text);
  const viewing = rt.isViewing(turn.threadId);
  const topic = turn.threadId !== se.threadId && rt.store.pending.thread(turn.threadId)?.kind === 'topic' ? turn.threadId : null;
  // The newest card that still waits (card-needs.mjs): this turn's asks, the kept turns' (a failed reply's Retry
  // among them), and the cards that wait until answered.
  const needs = nextNeed(rt, se, { turnIds: [turn.id, ...(se.keptTurnIds ?? [])], keep: waiting?.id ?? null });
  const mentionsYou = /(^|\W)@you\b/i.test(turn.said);
  rt.updateSession(se.id, (se) => ({
    state: stateFor(needs),
    needs,
    sideTurn: null,
    glimpse: '',
    subagents: [],
    currentStep: needs ? 'Waiting for you' : `Idle since ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
    lastMessage: last ? clip(last.text) : se.lastMessage,
    finishedAt: Date.now(),
    // A reply in a topic thread counts on the thread, not the conversation it answers from (#228). The count is the
    // pending session's (se, here): behind a held commit, the published one lost the increment of a turn before.
    unread: topic ? se.unread : viewing ? 0 : se.unread + (turn.said || open.length ? 1 : 0),
    stopAsk: null,
  }));
  noticeNeed(rt, se, needs);
  if (needs && (needs.kind === 'block' || needs.kind === 'toolask')) rt.notify('blocking', se, `@${se.handle} needs you`, needs.text, needs.threadId);
  else if (mentionsYou && !viewing) rt.notify('info', se, `@${se.handle} mentioned you`, clip(turn.said, 120), turn.threadId);
  else if (turn.said && !viewing) rt.notify('info', se, `@${se.handle} finished`, clip(turn.said, 120), turn.threadId);

  // The checks: what this turn sent, as problems, which go back to the agent in one lint turn. A lint turn is
  // never linted again, so this can’t loop; one that only called tools ends as a note instead of a reply.
  const stalled = rt.stallSteps(turn, se);
  if (turn.kind === 'lint') rt.quietLint(turn, se);
  else rt.endLint(turn, [...rt.checkTurn(turn, se), ...stalled]);
  if (topic && !viewing && (turn.said || open.length)) updateThread(rt, topic, (x) => ({ unread: (x.unread ?? 0) + 1 }));
  if (turn.threadId !== se.threadId) settleThread(rt, turn.threadId);

  rt.wakeMentions(se, turn, turn.said);
  rt.takePending(se, turn, true);
}
