// What the person needs after a turn that went well (designs/architecture/services.md, “The end of a turn”, step N):
// the turn’s open asks or the block it found waiting, the session’s state and unread count, and a notification. Moved
// from server/turn-finish.mjs.

import { ASKING } from '../shared/catalog.mjs';
import { clip } from './helpers.mjs';

/**
 * What the person needs after a turn that went well: this turn's open asks or the block it found waiting, the
 * session's state and unread count, and a notification. Returns what the checks and wakes after it read.
 * @param {any} rt @param {any} se @param {any} turn @param {any[]} items
 */
export function needsAfter(rt, se, turn, items) {
  // Only this turn’s asking blocks make the agent need you. Older ones you left open stay open, and the
  // client shows them quietly (“1 open review”), so moving on clears needs-you (#69). A turn you didn’t start
  // (a lint or app-check pass, another agent’s wake or review) isn’t moving on: the block it was waiting on still counts.
  const open = items.filter(
    (it) => it.kind === 'block' && it.turnId === turn.id && it.sessionId === se.id && it.valid && ASKING.has(it.block.type) && !it.answered,
  );
  const waiting = rt.turnService.asks.keptBlock(se);
  // It counts as the need wherever it is (#647), but as this thread’s activity only when it’s here (#228).
  if (!open.length && waiting && !waiting.answered && items.some((it) => it.id === waiting.id)) open.push(waiting);
  const last = [...items].reverse().find((it) => it.kind === 'agent' && it.sessionId === se.id && it.text);
  const viewing = rt.threads.isViewing(turn.threadId);
  const topic = turn.threadId !== se.threadId && rt.store.pending.thread(turn.threadId)?.kind === 'topic' ? turn.threadId : null;
  // The newest card that still waits (card-needs.mjs): this turn's asks, the kept turns' (a failed reply's Retry
  // among them), and the cards that wait until answered.
  const asks = rt.turnService.asks;
  const needs = asks.nextNeed(se, { turnIds: [turn.id, ...(se.keptTurnIds ?? [])], keep: waiting?.id ?? null });
  const mentionsYou = /(^|\W)@you\b/i.test(turn.said);
  rt.sessions.update(se.id, (se) => ({
    state: asks.stateFor(needs),
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
  // The block the turn kept was already the need, and the person was told when it became one: a turn that didn’t
  // change it raises no new alert, and falls through to the notices below (designs/developing.md, “Design habits”, 12).
  const changed = needs && needs.itemId !== se.keptId;
  if (changed && (needs.kind === 'block' || needs.kind === 'toolask')) rt.threads.notify('blocking', se, `@${se.handle} needs you`, needs.text, needs.threadId);
  else if (mentionsYou && !viewing) rt.threads.notify('info', se, `@${se.handle} mentioned you`, clip(turn.said, 120), turn.threadId);
  else if (turn.said && !viewing) rt.threads.notify('info', se, `@${se.handle} finished`, clip(turn.said, 120), turn.threadId);
  return { open, viewing, topic };
}
