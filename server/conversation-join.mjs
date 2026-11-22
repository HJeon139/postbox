// Bringing a persona into a conversation, its pool of agents, one session each (#228): the session it has there, or a
// new one with a brief. Moved from side-threads.mjs’s sideSession, so a mention in a side thread and the Agents
// header’s + decide it in one place. A message, a wake card, a proposal, a new persona and a new conversation still
// call rt.ensureSession themselves.

import { httpError, retiredError } from './helpers.mjs';

/**
 * The persona’s session in the conversation of `threadId` (itself, or the one a topic or side thread is of), made with
 * `brief` and `joined` if it has none, and with a line saying it joined when `line` asks for one. A session there that
 * was retired (#228) is refused, and so is a retired persona with none: handles are unique only among the active ones,
 * so it could put two agents of one name in a room (#1620).
 * @param {any} rt @param {string} threadId @param {string} personaId
 * @param {{ brief?: string|null, joined?: { by: string, in: string } | null, line?: boolean }} [opts]
 */
export function joinConversation(rt, threadId, personaId, { brief = null, joined = null, line = false } = {}) {
  // As written: a topic, or its conversation, opened behind a held commit isn’t published yet (#1292).
  const conv = rt.threads.lineage(threadId, (id) => rt.store.pending.thread(id)).at(-1);
  const had = rt.sessions.pendingIn(conv).find((x) => x.personaId === personaId);
  if (had?.retiredFork) throw retiredError(had);
  if (had) return had;
  const p = rt.persona(personaId);
  if (p?.retired) throw httpError(409, `@${p.handle} is retired. Bring it back in Settings › Personas to add it.`);
  const se = rt.ensureSession(conv, personaId, { brief, ...(joined ? { joined } : {}) });
  if (line) rt.threads.addItem(conv, { kind: 'system', variant: 'joined', to: se.handle });
  return se;
}
