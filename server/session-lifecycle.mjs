// A session’s lifecycle (#101, #320, #604): archiving and restoring a conversation with every session under it, and
// deleting a session or a whole conversation at once. A conversation owns its agents’ sessions, so a session is archived
// and restored only with its conversation; deleting one alone takes its conversation with it when it was alone there.
// Moved out of server/runtime.mjs; Runtime keeps a method of the same name that delegates here.

import { httpError } from './helpers.mjs';
import * as queue from './message-queue.mjs';
import { dropWakes } from './side-threads.mjs';
import { eraseThreads } from './thread-erase.mjs';
import { updateThread } from './thread-write.mjs';

/**
 * Deletes an older Postbox left pending in its Undo window, which is gone: each finishes now, as a delete does.
 * Delete is just delete.
 */
export function finishLeftDeletes(rt) {
  for (const se of Object.values(rt.s.sessions)) if (se.deleting && rt.s.sessions[se.id]) rt.deleteSession(se.id);
  for (const t of Object.values(rt.s.threads)) if (t.deleting && rt.s.threads[t.id]) rt.deleteThread(t.id);
}

export function archive(rt, sessionId) {
  rt.stop(sessionId, { silent: true });
  // A turn on a host waiting to be attached again after a restart, or to resume, isn’t attached or resumed (#120).
  rt.remote.cancel(sessionId);
  const se = rt.session(sessionId);
  rt.updateSession(sessionId, { archived: true, state: 'idle', needs: null, archivedAt: Date.now() });
  dropWakes(rt, se, 'archived');
  if (rt.sessionsIn(se.threadId).every((x) => x.id === sessionId || x.archived)) updateThread(rt, se.threadId, { archived: true });
}

export function restore(rt, sessionId) {
  const se = rt.session(sessionId);
  if (se.retiredFork) throw httpError(409, 'A fork from before agents had one session per conversation can’t come back: its agent answers there now.');
  rt.updateSession(sessionId, { archived: false, archivedAt: null });
  updateThread(rt, se.threadId, (t) => (t.archived ? { archived: false } : null));
}

/**
 * A conversation or room and every thread under it, a side thread a topic thread’s fork woke included: what
 * archiving, restoring or deleting it covers (#101, #320).
 */
export function archiveScope(rt, threadId) {
  const t = rt.thread(threadId);
  if (t.kind === 'topic' || t.kind === 'side') throw httpError(409, 'Archive the conversation it belongs to instead.');
  return [t, ...Object.values(rt.s.threads).filter((x) => x.id !== t.id && rt.lineage(x.id).at(-1) === t.id)];
}

/**
 * Archives a conversation (#101): every session in it, its side and topic threads’ forks too, through archive(),
 * so each keeps its transcript and its backend session for Restore. It leaves the rail. A session is archived only
 * this way, with its conversation (#320): archive() has no route of its own.
 */
export function archiveThread(rt, threadId) {
  const threads = rt.archiveScope(threadId);
  const ids = threads
    .flatMap((t) => rt.sessionsIn(t.id))
    .filter((se) => !se.archived)
    .map((se) => se.id);
  for (const id of ids) rt.archive(id);
  for (const t of threads) updateThread(rt, t.id, (x) => (x.archived ? null : { archived: true }));
  // What it archived: every agent here that wasn’t yet.
  return ids;
}

/** Restores every archived session in a conversation and its side and topic threads, and the threads with them. */
export function restoreThread(rt, threadId) {
  const threads = rt.archiveScope(threadId);
  // A fork retired by #228’s migration stays archived.
  for (const t of threads) for (const se of rt.sessionsIn(t.id)) if (se.archived && !se.retiredFork) rt.restore(se.id);
  for (const t of threads) updateThread(rt, t.id, (x) => (x.archived ? { archived: false } : null));
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
    eraseThreads(rt, t.kind === 'topic' || t.kind === 'side' ? [t.id] : rt.archiveScope(t.id).map((x) => x.id), 'Its session was deleted.', [sessionId]);
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
  const scope = rt.archiveScope(threadId);
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
