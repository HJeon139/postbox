// Which messages in a transcript name their speaker: a line with the agent’s ring, its handle and the time.

import { recordMoved } from './activity-paint.mjs';
import { busy, client, itemsOf } from './client.mjs';

/**
 * Whether the transcript draws nothing for a reply: one replaced by its replay (#120, a turn on a host attached again
 * after a restart), or a finished turn’s first part with only steps, whose record shows with its words below. Such a
 * reply has no speaker line, so the next part of its turn names the speaker (#1654). @param {any} it @param {string} threadId
 */
export const drawsNothing = (it, threadId) => it.kind === 'agent' && (it.status === 'replaced' || recordMoved(it, threadId));

/** @param {any} it @param {string} threadId */
function speaker(it, threadId) {
  if (it.kind === 'user') return `you:${it.by?.id ?? ''}`; // each person is a speaker of their own (#558)
  if (it.kind === 'agent') return drawsNothing(it, threadId) ? null : `s:${it.sessionId}`;
  return it.kind === 'block' || it.kind === 'proposal' ? `s:${it.sessionId}` : null;
}
// One turn’s items share a sender line; a later turn of the same agent gets its own, and so does a wake it sent from
// another turn (its fromTurnId) (#135). An item from before turns were kept, or no turn made, goes with the one before.
const turnOf = (it) => it.turnId ?? it.fromTurnId;
const sameTurn = (a, b) => !turnOf(a) || !turnOf(b) || turnOf(a) === turnOf(b);

/** Whether a message names its speaker, given the one before it. @param {any} it @param {any} prev @param {string} threadId */
export const namesSpeaker = (it, prev, threadId) =>
  !(prev && speaker(prev, threadId) && speaker(prev, threadId) === speaker(it, threadId) && prev.kind !== 'voice' && sameTurn(prev, it));

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
    if (it.sessionId === sessionId && speaker(it, threadId)?.startsWith('s:') && namesSpeaker(it, list[i - 1], threadId)) found = it.id;
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
// What isLive reads of each session, last time it was heard: whether it works, and its last turn. Only a change in
// these can make a finished part draw nothing (drawsNothing), so only then is its latest reply found again (#1654);
// any other session event, the most frequent, keeps the cached one, as #564-b1 asks. Registered as this module loads,
// before reply-rings.mjs’s listener, which imports it, so the cache is right by the time the lines are painted.
/** @type {Map<string, string>} */
const live = new Map();
client.on((ch) => {
  if (ch.type === 'load') latest.clear();
  const se = ch.type === 'session' ? ch.data : null;
  if (se?.id) {
    const now = `${busy(se)}|${se.lastTurnId ?? ''}`;
    if (live.get(se.id) !== now) {
      live.set(se.id, now);
      for (const key of latest.keys()) if (key.endsWith(`\n${se.id}`)) latest.delete(key);
    }
  }
  const threadId = ch.type.startsWith('item.') ? ch.data?.threadId : null;
  if (!threadId) return;
  for (const key of latest.keys()) if (key.startsWith(`${threadId}\n`)) latest.delete(key);
});
