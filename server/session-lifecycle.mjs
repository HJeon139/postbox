// A session’s lifecycle (#320, #604): deleting a session or a whole conversation at once. A conversation owns its
// agents’ sessions, so deleting one alone takes its conversation with it when it was alone there.
// Moved out of server/runtime.mjs; Runtime keeps a method of the same name that delegates here.

import { httpError } from './helpers.mjs';
import * as queue from './message-queue.mjs';
import { dropWakes } from './side-threads.mjs';
import { eraseThreads } from './thread-erase.mjs';
import { updateThread } from './thread-write.mjs';

/**
 * A conversation or room and every thread under it, a side thread a topic thread’s fork woke included: what deleting
 * it covers (#320). Its callers refuse a topic or side thread first.
 */
function conversationScope(rt, threadId) {
  const t = rt.thread(threadId);
  return [t, ...Object.values(rt.s.threads).filter((x) => x.id !== t.id && rt.lineage(x.id).at(-1) === t.id)];
}

/**
 * Deletes a session at once: its turn stops, its wakes and queued messages go, and if it was alone in its conversation,
 * the conversation goes with it. In a room it leaves, and its past messages stay, marked deleted. The persona stays.
 * There is no Undo window, so nothing is held for it (#604, #599).
 */
export function deleteSession(rt, sessionId) {
  const se = rt.session(sessionId);
  rt.stop(sessionId, { silent: true });
  // A turn of one on a host, waiting to be attached again or to resume, is neither, as deleting a conversation does.
  rt.remote.cancel(sessionId);
  dropWakes(rt, se, 'removed');
  // The person’s messages queued for it leave the queue (#427).
  queue.releaseQueued(rt, sessionId);
  // Background jobs Postbox kept running for it would run on with no record (#129).
  rt.stopKeptJobs([sessionId], 'Its session was deleted.').catch((e) => console.error(`Couldn’t stop a deleted session’s jobs: ${e.message}`));
  const t = rt.store.pending.thread(se.threadId); // a member that joined behind a held commit keeps its room (#796)
  const others = (t?.members ?? []).filter((id) => id !== sessionId && rt.store.pending.session(id));
  if (t && !others.length) {
    // Its own conversation goes with it, as deleting the conversation does: every thread under it, with its sessions
    // and apps (#320).
    eraseThreads(rt, t.kind === 'topic' || t.kind === 'side' ? [t.id] : conversationScope(rt, t.id).map((x) => x.id), 'Its session was deleted.', [sessionId]);
  } else if (t) {
    const gone = t.members.filter((id) => !others.includes(id)); // it, and any member whose session is gone; a held join stays
    updateThread(rt, t.id, (x) => ({
      members: x.members.filter((id) => !gone.includes(id)),
      lastSpeaker: x.lastSpeaker === sessionId ? (others[0] ?? null) : x.lastSpeaker,
    }));
    for (const it of rt.store.pending.items(t.id)) if (it.sessionId === sessionId) rt.patchItem(t.id, it.id, { deletedAgent: true });
    rt.addItem(t.id, { kind: 'system', variant: 'left', to: se.handle });
  }
  if (rt.s.sessions[sessionId]) rt.store.emit('remove', { kind: 'session', id: sessionId });
  return { handle: se.handle };
}

/**
 * Deletes a whole conversation or room at once: every session in it, its apps, and its topic and side threads. The
 * personas stay. There is no Undo window.
 */
export function deleteThread(rt, threadId) {
  const t = rt.thread(threadId);
  if (t.kind === 'topic' || t.kind === 'side') throw httpError(409, 'Delete the conversation it belongs to instead.');
  const scope = conversationScope(rt, threadId);
  // A turn of one on a host, waiting to be attached again or to resume, is neither (#120).
  for (const x of scope)
    for (const se of rt.sessionsIn(x.id)) {
      rt.stop(se.id, { silent: true });
      rt.remote.cancel(se.id);
    }
  eraseThreads(
    rt,
    scope.map((x) => x.id),
    'Its conversation was deleted.',
  );
  return { title: t.title };
}
