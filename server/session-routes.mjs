// The routes for one session (an agent in a conversation): Stop, delete, Stop’s question
// about background jobs and a job’s own Stop (#129), and the composer’s /model and /effort for it (#67); and deleting a
// persona, which deletes its sessions (#208). Moved out of server/index.mjs, whose route() keeps one line that
// calls this.

import { deletePersona } from './persona-delete.mjs';

/** A route’s answer: its status and its JSON body. */
const done = (status, body) => ({ status, body });

/**
 * Answers a session route, or null when the path isn’t one.
 * @param {any} rt @param {string} path @param {string} method @param {any} body
 * @returns {Promise<{ status: number, body: any } | null>}
 */
export async function sessionRoute(rt, path, method, body) {
  let m;
  if ((m = path.match(/^\/api\/sessions\/([^/]+)\/stop$/)) && method === 'POST') {
    rt.session(m[1]);
    const result = rt.requestStop(m[1], { jobs: body.jobs ?? null, turnId: body.turnId ?? null, subagent: body.subagent ?? null });
    return done(200, { ok: true, result: result ?? null });
  }
  if ((m = path.match(/^\/api\/sessions\/([^/]+)$/)) && method === 'DELETE') return done(200, rt.deleteSession(m[1]));
  // Stop’s ask about background jobs, dismissed, and a background job’s own Stop (#129).
  if ((m = path.match(/^\/api\/sessions\/([^/]+)\/stop-ask$/)) && method === 'DELETE') {
    rt.dismissStopAsk(m[1]);
    return done(200, { ok: true });
  }
  if ((m = path.match(/^\/api\/sessions\/([^/]+)\/jobs\/([^/]+)\/stop$/)) && method === 'POST')
    return done(200, await rt.stopJob(m[1], decodeURIComponent(m[2])));
  // The composer’s commands (#67): /model and /effort for this conversation, an agent’s skill as its turn, and !.
  if ((m = path.match(/^\/api\/sessions\/([^/]+)\/run$/)) && method === 'POST') return done(200, await rt.setSessionRun(m[1], body));
  // Deleting a persona (#208, server/persona-delete.mjs), at once.
  if ((m = path.match(/^\/api\/personas\/([^/]+)$/)) && method === 'DELETE') return done(200, { handle: deletePersona(rt, m[1]).handle });
  return null;
}
