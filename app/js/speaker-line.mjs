// Which messages in a transcript name their speaker: a line with the agent’s ring, its handle and the time.

import { client, itemsOf } from './client.mjs';

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
  const key = `${threadId}\n${sessionId}`;
  if (latest.has(key)) return latest.get(key) ?? null;
  const list = itemsOf(threadId);
  let found = null;
  for (let i = list.length - 1; i >= 0 && !found; i--) {
    const it = list[i];
    if (it.sessionId === sessionId && speaker(it)?.startsWith('s:') && namesSpeaker(it, list[i - 1])) found = it.id;
  }
  latest.set(key, found);
  return found;
}
// Each thread’s latest reply per session, found once and kept until that thread’s items change. A session event, the
// most frequent, changes no item, so it reads this rather than walking the thread from its end, which for a session with
// no reply there is every item (#564-b1). Registered as this module loads, so it hears a change before the transcript
// and the speaker lines do.
/** @type {Map<string, string | null>} */
const latest = new Map();
client.on((ch) => {
  if (ch.type === 'load') latest.clear();
  const threadId = ch.type.startsWith('item.') ? ch.data?.threadId : null;
  if (!threadId) return;
  for (const key of latest.keys()) if (key.startsWith(`${threadId}\n`)) latest.delete(key);
});
