// A conversation’s own record (#101, #110, #228): starting one with the agents it starts with, giving an agent its one
// session there (a second agent makes it a room), and naming it. Moved out of server/runtime.mjs; Runtime keeps a
// method of each name that delegates here.

import { httpError } from './helpers.mjs';
import { pendingSessionsIn } from './session-write.mjs';
import { newId } from './store.mjs';
import { updateThread } from './thread-write.mjs';
import { liftDecline } from './wake-cards.mjs';

/** @param {any} rt @param {{ projectId: string, title: string, personaIds?: string[], kind?: string, parentId?: string|null }} opts */
export function createThread(rt, { projectId, title, personaIds = [], kind = 'thread', parentId = null }) {
  if (!rt.s.projects[projectId]) throw httpError(404, 'That project doesn’t exist.');
  const t = rt.putThread({
    id: newId('th'),
    projectId,
    title: title || 'New conversation',
    kind,
    parentId,
    members: [],
    lastSpeaker: null,
    hops: 0,
    queue: [],
    createdAt: Date.now(),
  });
  for (const pid of personaIds) rt.ensureSession(t.id, pid);
  return rt.s.threads[t.id];
}

/** One session per persona per thread. Adding a second agent turns a thread into a room. */
/**
 * @param {any} rt @param {string} threadId @param {string} personaId
 * @param {{ brief?: string|null, joined?: { by: string, in: string } | null }} [opts]
 *   joined: it joins to answer in a side thread, woken by `by` (a handle, or 'you') in thread `in` (#110)
 */
export function ensureSession(rt, threadId, personaId, { brief, joined = null } = {}) {
  rt.thread(threadId);
  const existing = pendingSessionsIn(rt, threadId).find((x) => x.personaId === personaId);
  if (existing) return existing;
  const p = rt.persona(personaId);
  if (!p) throw httpError(404, 'That agent doesn’t exist.');
  const se = rt.putSession({
    id: newId('se'),
    personaId,
    threadId,
    handle: p.handle,
    backend: p.backend,
    state: 'idle',
    ctx: null,
    subagents: [],
    compactions: 0,
    toolCount: 0,
    toolCalls: [],
    currentStep: '',
    lastMessage: '',
    agentMessages: [],
    needs: null,
    unread: 0,
    startedAt: Date.now(),
    finishedAt: null,
    brief: brief ?? null,
    // The person never added it, so its row says why it’s here (decided by the person, 23 October 2026).
    ...(joined ? { joinedBy: joined.by, joinedIn: joined.in } : {}),
    // Nothing given yet: its first turn starts with the conversation so far (see catchUp).
    seenItem: null,
  });
  updateThread(rt, threadId, (x) => ({ members: [...x.members, se.id], kind: x.kind === 'thread' && x.members.length > 0 ? 'room' : x.kind }));
  liftDecline(rt, threadId, p.handle); // the person added it: a decline of adding it here no longer holds (#789)
  return se;
}

export function renameThread(rt, threadId, title) {
  rt.thread(threadId);
  const name = String(title ?? '')
    .trim()
    .slice(0, 120);
  if (!name) throw httpError(422, 'A conversation needs a name.');
  return updateThread(rt, threadId, { title: name });
}
