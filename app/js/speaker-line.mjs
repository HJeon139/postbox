// Which messages in a transcript name their speaker: a line with the agent’s ring, its handle and the time.

import { itemsOf } from './client.mjs';

// A reply replaced by its replay (#120: a turn on a host attached again after a restart) shows nothing, so the replay
// after it names its speaker.
const speaker = (it) =>
  it.kind === 'user' ? 'you' : (it.kind === 'agent' && it.status !== 'replaced') || it.kind === 'block' || it.kind === 'proposal' ? `s:${it.sessionId}` : null;
// One turn’s items share a sender line; a later turn of the same agent gets its own, and so does a wake it sent from
// another turn (its fromTurnId) (#135). An item from before turns were kept, or no turn made, goes with the one before.
const turnOf = (it) => it.turnId ?? it.fromTurnId;
const sameTurn = (a, b) => !turnOf(a) || !turnOf(b) || turnOf(a) === turnOf(b);

/** Whether a message names its speaker, given the one before it. */
export const namesSpeaker = (it, prev) => !(prev && speaker(prev) && speaker(prev) === speaker(it) && prev.kind !== 'voice' && sameTurn(prev, it));

/**
 * The id of a session’s latest message in a thread that names its speaker: the line whose ring and status words follow
 * the session (#622). A turn’s later parts sit under that line, so a part with no line of its own isn’t it.
 * @param {string} threadId @param {string} sessionId
 */
export function latestReply(threadId, sessionId) {
  const list = itemsOf(threadId);
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i];
    if (it.sessionId === sessionId && speaker(it)?.startsWith('s:') && namesSpeaker(it, list[i - 1])) return it.id;
  }
  return null;
}
