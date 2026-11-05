// The remote hosts’ routes (#120), which server/index.mjs’s route() calls in one line: add, change and remove one, a
// project’s folder on one, installing Postbox’s host program (the page shows the GET’s text and asks first),
// connecting again, keeping it up to date by itself (#464-b2a), and the connection’s status. The hosts and their
// status are also in /api/state, kept current by 'host' and 'host.status' events. Every write here needs the page’s
// token, as every other one does (tests/server-token.test.mjs reads this file).

import { setHostKeepUpdated } from './remote/host-status.mjs';

const done = (status, body) => ({ status, body });

/**
 * The response for a hosts route, or null when the path isn’t one.
 * @param {any} rt @param {string} path @param {string} method @param {any} body  null for a GET
 * @returns {Promise<{ status: number, body: any } | null>}
 */
export async function hostsRoute(rt, path, method, body) {
  let m;
  if ((m = path.match(/^\/api\/hosts\/([^/]+)\/install$/)) && method === 'GET') return done(200, await rt.describeHostInstall(m[1]));
  if ((m = path.match(/^\/api\/hosts\/([^/]+)\/status$/)) && method === 'GET') return done(200, { status: rt.hostStatus(m[1]) });
  if (path === '/api/hosts' && method === 'POST') return done(201, rt.addHost(body));
  if ((m = path.match(/^\/api\/hosts\/([^/]+)$/)) && method === 'PATCH') return done(200, rt.updateHost(m[1], body));
  if ((m = path.match(/^\/api\/hosts\/([^/]+)$/)) && method === 'DELETE') return done(200, await rt.removeHost(m[1]));
  if ((m = path.match(/^\/api\/hosts\/([^/]+)\/install$/)) && method === 'POST') return done(200, await rt.installHost(m[1]));
  if ((m = path.match(/^\/api\/hosts\/([^/]+)\/retry$/)) && method === 'POST') return done(200, rt.retryHost(m[1], { takeover: body.takeover ?? false }));
  if ((m = path.match(/^\/api\/hosts\/([^/]+)\/keep-updated$/)) && method === 'PUT') return done(200, await setHostKeepUpdated(rt, m[1], body));
  if ((m = path.match(/^\/api\/projects\/([^/]+)\/hosts\/([^/]+)\/folder$/)) && method === 'PUT')
    return done(200, rt.setProjectHostFolder(m[1], m[2], body.folder));
  return null;
}
