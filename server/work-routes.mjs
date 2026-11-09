// The Work view’s JSON routes (#132), which server/index.mjs’s route() calls in one line: where each change stands in
// git, a file’s diff, and an archived turn’s entries (#305). A command’s output stays in route(), as it answers with
// text, not JSON.

import { workTurn } from './work-archive-routes.mjs';

const done = (status, body) => ({ status, body });

/**
 * The answer to a Work route, or null when the request isn’t one.
 * @param {import('./runtime.mjs').Runtime} rt @param {string} path @param {string | undefined} method @param {URL} url
 */
export async function workRoute(rt, path, method, url) {
  if (method !== 'GET') return null;
  let m;
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/work\/git$/))) return done(200, await rt.workGit(m[1]));
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/work\/files\/([^/]+)\/diff$/)))
    return done(200, await rt.workDiff(m[1], m[2], url.searchParams.get('change')));
  // “Show details” on an archived turn’s summary row: the turn id goes to the lookup, never into a path (I6).
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/work\/turns\/([^/]+)$/))) return done(200, await workTurn(rt, m[1], m[2]));
  return null;
}
