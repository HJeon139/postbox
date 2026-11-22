// Bringing a persona into a conversation, its pool of agents, one session each (#228): the session it has there, or a
// new one with a brief. Moved from side-threads.mjs’s sideSession, so every way in decides it in one place.

import { retiredError } from './helpers.mjs';

/**
 * The persona’s session in the conversation of `threadId` (itself, or the one a topic or side thread is of), made with
 * `brief` and `joined` if it has none. A session there that was retired (#228) is refused.
 * @param {any} rt @param {string} threadId @param {string} personaId
 * @param {{ brief?: string|null, joined?: { by: string, in: string } | null }} [opts]
 */
export function joinConversation(rt, threadId, personaId, { brief = null, joined = null } = {}) {
  // As written: a topic, or its conversation, opened behind a held commit isn’t published yet (#1292).
  const conv = rt.threads.lineage(threadId, (id) => rt.store.pending.thread(id)).at(-1);
  const had = rt.sessions.pendingIn(conv).find((x) => x.personaId === personaId);
  if (had?.retiredFork) throw retiredError(had);
  return had ?? rt.ensureSession(conv, personaId, { brief, ...(joined ? { joined } : {}) });
}
