// The projects’ routes, which server/index.mjs’s route() calls in one line: making one, the repository a push goes to,
// and its folder as the folder picker lists it. Moved out of server/index.mjs, which is at its size. Every write here
// needs the page’s token, as every other one does (tests/server-token.test.mjs reads this file).

import { listFolder } from './folders.mjs';
import { createProject, setPushUrl } from './projects.mjs';

const done = (status, body) => ({ status, body });

/**
 * The response for a projects route, or null when the path isn’t one.
 * @param {any} store @param {string} path @param {string} method @param {any} body  null for a GET
 * @param {URLSearchParams} query
 * @returns {Promise<{ status: number, body: any } | null>}
 */
export async function projectsRoute(store, path, method, body, query) {
  let m;
  if (path === '/api/projects' && method === 'POST') return done(201, await createProject(store, body));
  if ((m = path.match(/^\/api\/projects\/([^/]+)\/push-url$/)) && method === 'PUT') return done(200, setPushUrl(store, m[1], body.url));
  if ((m = path.match(/^\/api\/projects\/([^/]+)\/files$/)) && method === 'GET')
    return done(200, await listFolder(store.state.projects[m[1]], query.get('path') ?? ''));
  return null;
}
