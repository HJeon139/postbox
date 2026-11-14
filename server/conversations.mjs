// An agent’s one session in a conversation (#101, #110, #228): a second agent makes it a room. Moved out of
// server/runtime.mjs; Runtime keeps a method of that name that delegates here. Starting and naming a conversation
// moved to server/threads.mjs.

import { httpError } from './helpers.mjs';
import { pendingSessionsIn } from './session-write.mjs';
import { newId } from './store.mjs';
import { threadToWrite, updateThread } from './threads.mjs';
import { liftDecline } from './wake-cards.mjs';

/** One session per persona per thread. Adding a second agent turns a thread into a room. */
/**
 * @param {any} rt @param {string} threadId @param {string} personaId
 * @param {{ brief?: string|null, joined?: { by: string, in: string } | null }} [opts]
 *   joined: it joins to answer in a side thread, woken by `by` (a handle, or 'you') in thread `in` (#110)
 */
export function ensureSession(rt, threadId, personaId, { brief, joined = null } = {}) {
  // Read pending: a conversation createThread just wrote may still be held behind a commit.
  threadToWrite(rt, threadId);
  const existing = pendingSessionsIn(rt, threadId).find((x) => x.personaId === personaId);
  if (existing) return existing;
  // Pending too: an agent the request just made may be held behind a commit with the thread.
  const p = rt.store.pending.persona(personaId);
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
