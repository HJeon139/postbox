// A final reply’s @-mentions become entries in the inbox of each agent they name (designs/architecture/services.md,
// “Delivery and Turns, built as the inbox”; designs/rooms-at-scale.md, “Which mention wakes”). The root listens to
// item.final with it, so a mention is handed over once its message is whole, never mid-stream (#834), and in place of
// the wakes the end of a turn made. Each mention still goes through agentWake (server/side-threads.mjs), whose cards
// stand in for the chain cap’s Continue and an absent agent’s add until Asks replaces them. Functions take the Runtime
// first, as waiting code does until Turns is a service.

import { parseMentions } from '../shared/text.mjs';
import { copiedLine } from './copied-line.mjs';
import { endedByReaction } from './reply-back.mjs';

/**
 * The entries a final item’s mentions make: only an agent’s reply from a turn Postbox ran (not one mirrored from a
 * terminal, not a shell command’s output), and none from a summary’s turn, which wakes no one (#225). A reply doesn’t go
 * back to the agent that wrote it, nor to one the failed reply a Retry answers already woke (#485), nor to one whose
 * exchange with the turn a reaction ended (#1591). A reply settled
 * while its turn ends waits for that end to wake anyone (`wake: false`), so a failed reply’s entry reads its error.
 * @param {any} rt @param {{ threadId: string, item: any }} final
 */
export function mentionEntries(rt, { threadId, item }) {
  if (item.kind !== 'agent' || item.via === 'terminal' || !item.turnId || !item.sessionId) return;
  // A reply the person stopped hands nothing over, as a stopped turn woke no one before.
  if (item.status === 'stopped') return;
  // A reply a restart or an outage left without its turn wakes no one, as before.
  const turn = rt.running.turnFor(item.sessionId, item.turnId);
  if (!turn || turn.summarizeTo) return;
  const se = rt.store.pending.session(item.sessionId);
  if (!se) return;
  // A host turn that goes on after its link was lost hands over when it ends, from the replies its replay posts.
  if (turn.endErr && (turn.endErr.remote || se.remoteTurn?.state === 'lost')) return;
  const live = rt.running.turnOf(item.sessionId) === turn;
  // Where it spoke: a topic thread, else the conversation (agentWake takes null for the session’s own thread).
  const replyIn = threadId !== se.threadId ? threadId : null;
  // Each mention after the first reuses the message the first went out as: a reply in an old side thread posts it once.
  let said = item.id;
  for (const h of parseMentions(item.text, rt.personas.handles(), copiedLine(rt, se))) {
    if (h.toLowerCase() === se.handle.toLowerCase()) continue;
    // The turn reacted to what this agent sent it, and did no work: that ended their exchange (#1553), so naming it
    // in the words that follow is no request (#1591). “I reacted ✅ to @critic’s closing message and haven’t replied”
    // woke critic about every four seconds in the paid runs of 26 November 2026. A reaction made after these words
    // settled comes too late to hold the wake.
    if (endedByReaction(rt, se, rt.delivery.takenBy(se.id, turn.id), h, turn)) continue;
    // It named an agent, so it doesn’t go back to the one that woke it (reply-back.mjs), whether or not this wakes it.
    turn.named = true;
    // And a reply of its own named one, which open_topic and a review don’t set: the reply-form checks read it (#1695).
    turn.addressed = true;
    if (turn.woken.includes(h)) continue;
    const opts = { replyIn, fromTurnId: turn.id, itemId: said, prose: true, wake: live, retryId: replayKey(turn, h) };
    const r = rt.agentWake(se.id, h, item.text, opts);
    if (r.itemId) said = r.itemId;
    if (r.ok || r.waiting) turn.mentioned = [...new Set([...(turn.mentioned ?? []), h])];
    else rt.sessions.tell(se.id, `Your mention of @${h} woke no one: ${r.message}`);
  }
}

/**
 * The retry id of a host turn’s mention (#1138’s class): a turn replayed from its start after a restart posts its
 * replies again, as new items, so its n-th mention of an agent is keyed by the host turn, not by the item, and the
 * replay’s copy is stored once. A turn on this computer is never replayed, and has none.
 * @param {any} turn @param {string} handle
 */
function replayKey(turn, handle) {
  const hostTurn = turn.remote?.current;
  if (!hostTurn) return undefined;
  turn.mentionCount ??= {};
  const n = turn.mentionCount[handle] ?? 0;
  turn.mentionCount[handle] = n + 1;
  return `${hostTurn}:${handle}:${n}`;
}

/**
 * The end of a turn wakes the agents its replies settled there mentioned, now that its replies say how it ended. The
 * entries were stored when each reply was final; Delivery raises entry.waiting for each agent that can start a turn.
 * @param {any} rt @param {any} turn
 */
export function wakeMentioned(rt, turn) {
  for (const h of turn.mentioned ?? []) {
    const p = rt.personas.byHandle(h);
    const conv = rt.threads.conversationToWrite(turn.threadId);
    const target = p && rt.sessions.pendingIn(conv).find((x) => x.personaId === p.id && !x.retiredFork);
    if (target) rt.delivery.wake(target.id);
  }
}
