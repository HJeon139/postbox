// A session’s lifecycle (#320, #604): deleting a session or a whole conversation at once. A conversation owns its
// agents’ sessions, so deleting one alone takes its conversation with it when it was alone there.
// Moved out of server/runtime.mjs; Runtime keeps a method of the same name that delegates here.

import { httpError } from './helpers.mjs';
import { dropSchedulesOf } from './scheduled-wakes.mjs';
import { dropWakes } from './side-threads.mjs';
import { eraseThreads } from './thread-erase.mjs';

/**
 * A conversation or room and every thread under it, a side thread a topic thread’s fork woke included: what deleting
 * it covers (#320). Its callers refuse a topic or side thread first. Read pending, as a delete’s every lookup is: a
 * conversation started behind a held commit is deleted too, not refused as gone halfway through.
 */
function conversationScope(rt, threadId) {
  const t = rt.threads.toWrite(threadId);
  const pending = (/** @type {string} */ id) => rt.store.pending.thread(id);
  return [t, ...Object.values(rt.store.pending.threads()).filter((x) => x.id !== t.id && rt.threads.lineage(x.id, pending).at(-1) === t.id)];
}

/**
 * The threads a session alone in thread t takes with it: a topic or side thread alone, else its whole conversation,
 * every thread under it with their sessions and apps (#320). @param {any} rt @param {any} t
 */
function erasedWith(rt, t) {
  if (t.kind === 'topic' || t.kind === 'side') return [t.id];
  return conversationScope(rt, t.id).map((x) => x.id);
}

/**
 * Deletes a session at once: its turn stops, its wakes and queued messages go, and if it was alone in its conversation,
 * the conversation goes with it, unless keepConversation asks that it stay, which refuses the delete instead. In a room
 * it leaves, and its past messages stay as they were, under its name (#1743). The persona stays. There is no Undo window, so nothing is held
 * for it (#604, #599).
 */
export function deleteSession(rt, sessionId, { keepConversation = false } = {}) {
  // Every lookup comes first, so a refusal leaves nothing half done; all read pending, so a session or a conversation
  // made behind a held commit is deleted too, not refused as gone.
  const se = rt.store.pending.session(sessionId);
  if (!se) throw httpError(404, 'That session doesn’t exist. It may have been deleted.');
  const t = rt.store.pending.thread(se.threadId); // a member that joined behind a held commit keeps its room (#796)
  const others = (t?.members ?? []).filter((id) => id !== sessionId && rt.store.pending.session(id));
  // The live ones: a retired fork beside it can’t take a message, so it doesn’t keep the room (#1620), as the page
  // counts them when it picks the confirm (#1743).
  const live = others.filter((id) => !rt.store.pending.session(id)?.retiredFork);
  // The last live agent there: its conversation goes with it, as deleting the conversation does (#320).
  const erase = t && !live.length ? erasedWith(rt, t) : null;
  // A remove from the Members bar or /delete in a room keeps the conversation (#1620, #1743): as the last agent’s, it’s
  // refused, so a remove that raced another doesn’t erase what its dialog said would stay.
  if (t && keepConversation && !live.length)
    throw httpError(409, `@${se.handle} is the last agent here, so removing it would delete the conversation. To end it, delete the conversation.`);
  rt.stop(sessionId, { silent: true, by: 'you' });
  // A turn of one on a host, waiting to be attached again or to resume, is neither, as deleting a conversation does.
  rt.remote.cancel(sessionId);
  dropWakes(rt, se, 'removed');
  // Background jobs Postbox kept running for it would run on with no record (#129).
  rt.stopKeptJobs([sessionId], 'Its session was deleted.').catch((e) => console.error(`Couldn’t stop a deleted session’s jobs: ${e.message}`));
  if (erase) eraseThreads(rt, erase, 'Its session was deleted.', [sessionId]);
  else if (t) {
    const gone = t.members.filter((id) => !others.includes(id)); // it, and any member whose session is gone; a held join stays
    rt.threads.patch(t.id, (x) => ({
      members: x.members.filter((id) => !gone.includes(id)),
      lastSpeaker: x.lastSpeaker === sessionId ? (others[0] ?? null) : x.lastSpeaker,
    }));
    for (const it of rt.store.pending.items(t.id)) if (it.sessionId === sessionId) rt.threads.patchItem(t.id, it.id, { deletedAgent: true });
    // Which agent left, by its persona as well as its handle: a new agent given the handle wasn’t deleted (#283).
    rt.threads.addItem(t.id, { kind: 'system', variant: 'left', to: se.handle, personaId: se.personaId });
  }
  dropSchedulesOf(rt, sessionId);
  rt.sessions.remove(sessionId);
  return { handle: se.handle };
}

/**
 * Deletes a whole conversation or room at once: every session in it, its apps, and its topic and side threads. The
 * personas stay. There is no Undo window.
 */
export function deleteThread(rt, threadId) {
  // Every lookup first, pending, as deleteSession’s.
  const t = rt.threads.toWrite(threadId);
  if (t.kind === 'topic' || t.kind === 'side') throw httpError(409, 'Delete the conversation it belongs to instead.');
  const scope = conversationScope(rt, threadId);
  // A turn of one on a host, waiting to be attached again or to resume, is neither (#120).
  for (const x of scope)
    for (const se of rt.sessions.pendingIn(x.id)) {
      rt.stop(se.id, { silent: true, by: 'you' });
      rt.remote.cancel(se.id);
    }
  eraseThreads(
    rt,
    scope.map((x) => x.id),
    'Its conversation was deleted.',
  );
  return { title: t.title };
}
