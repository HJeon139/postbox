// The routes for one session (an agent in a conversation): adding one (#1620), Stop, delete, Stop’s question
// about background jobs and a job’s own Stop (#129); and deleting a persona, which deletes its sessions (#208). Moved out of server/index.mjs, whose route() keeps one line that
// calls this.

import { httpError, retiredError } from './helpers.mjs';

/** A route’s answer: its status and its JSON body. */
const done = (status, body) => ({ status, body });

/**
 * Answers a session route, or null when the path isn’t one.
 * @param {any} rt @param {string} path @param {string} method @param {any} body
 * @returns {Promise<{ status: number, body: any } | null>}
 */
export async function sessionRoute(rt, path, method, body) {
  let m;
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/agents$/)) && method === 'POST') return done(201, addAgent(rt, m[1], body.personaId));
  if ((m = path.match(/^\/api\/sessions\/([^/]+)\/stop$/)) && method === 'POST') {
    rt.session(m[1]);
    const result = rt.requestStop(m[1], { jobs: body.jobs ?? null, turnId: body.turnId ?? null, subagent: body.subagent ?? null });
    return done(200, { ok: true, result: result ?? null });
  }
  if ((m = path.match(/^\/api\/sessions\/([^/]+)$/)) && method === 'DELETE') return done(200, rt.deleteSession(m[1]));
  // The Agents header’s −: the same delete, refused rather than erase the conversation if it’s the last agent (#1620).
  if ((m = path.match(/^\/api\/sessions\/([^/]+)\/remove$/)) && method === 'POST') return done(200, rt.deleteSession(m[1], { keepConversation: true }));
  // Stop’s ask about background jobs, dismissed, and a background job’s own Stop (#129).
  if ((m = path.match(/^\/api\/sessions\/([^/]+)\/stop-ask$/)) && method === 'DELETE') {
    rt.dismissStopAsk(m[1]);
    return done(200, { ok: true });
  }
  if ((m = path.match(/^\/api\/sessions\/([^/]+)\/jobs\/([^/]+)\/stop$/)) && method === 'POST')
    return done(200, await rt.stopJob(m[1], decodeURIComponent(m[2])));
  // Deleting a persona (#208, Runtime.deletePersona), at once.
  if ((m = path.match(/^\/api\/personas\/([^/]+)$/)) && method === 'DELETE') return done(200, { handle: rt.deletePersona(m[1]).handle });
  return null;
}

/**
 * The person adds an agent they have to a conversation, from the Agents header’s + (#1620): its session there, made
 * with a line saying it joined, or the one it already has. Asked from a topic thread, it joins the conversation.
 * @param {any} rt @param {string} threadId @param {unknown} personaId
 */
function addAgent(rt, threadId, personaId) {
  if (typeof personaId !== 'string' || !personaId) throw httpError(400, 'Pick an agent to add.');
  if (!rt.persona(personaId)) throw httpError(404, 'That agent doesn’t exist. It may have been deleted.');
  // As written: a conversation just started behind a held commit isn’t published yet (#1292). One that doesn’t exist
  // is refused where the session is written.
  const conv = rt.threads.lineage(threadId, (id) => rt.store.pending.thread(id)).at(-1);
  const here = rt.sessions.pendingIn(conv).find((x) => x.personaId === personaId);
  if (here?.retiredFork) throw retiredError(here);
  if (here) return here;
  const se = rt.ensureSession(conv, personaId, { brief: 'The person added you to this conversation.' });
  rt.threads.addItem(conv, { kind: 'system', variant: 'joined', to: se.handle });
  return se;
}
