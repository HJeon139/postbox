// net.fetch { url }: public data for an agent app, fetched by Postbox’s server (designs/architecture/sandbox.md, “Network
// through Postbox”; designs/architecture/security-boundaries.md, “What leaves through net.fetch”). The app’s own frame
// stays sandboxed and loads nothing. This sends no cookies or credentials, only GETs, follows no redirect, and never
// reaches this computer or the local network: an address is checked after DNS resolution, where the socket connects.

import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { NET_FETCH } from '../shared/limits.mjs';
import { httpError } from './helpers.mjs';
import { guardedLookup, privateAddress } from './net-address.mjs';
import { FetchLimits } from './net-fetch-limits.mjs';

/** Every app’s fetches, counted together, so the limits hold across apps and the total holds for Postbox. */
const LIMITS = new FetchLimits();

/**
 * Agents of net.fetch’s own, so a proxy the environment sets for node’s default agents (NODE_USE_ENV_PROXY with
 * HTTP_PROXY or HTTPS_PROXY) never applies: through one, the address checks would see only the proxy, and it would get
 * the proxy’s credentials.
 */
const AGENTS = { 'http:': new http.Agent(), 'https:': new https.Agent() };

/**
 * Hosts the demo treats as public, so the local stand-in for “another site” can be fetched: POSTBOX_FETCH_ALLOW,
 * host:port, comma-separated. Only for measuring; nothing sets it by default.
 */
const allowed = () => new Set((process.env.POSTBOX_FETCH_ALLOW ?? '').split(',').filter(Boolean));

/** The URL net.fetch may GET, or the reason it may not: refused before anything leaves. @param {unknown} url */
export function fetchableUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw httpError(400, 'net.fetch needs an absolute http or https URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw httpError(400, 'net.fetch fetches only http and https URLs.');
  if (u.username || u.password) throw httpError(400, 'net.fetch sends no credentials, so a URL can’t carry them.');
  const bare = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowed().has(u.host) && (u.hostname === 'localhost' || (isIP(bare) && privateAddress(bare))))
    throw httpError(403, `net.fetch refused ${u.host}: it’s on this computer or the local network.`);
  return u;
}

/**
 * net.fetch { url }: GET a public URL from Postbox’s server, with no cookies or credentials, and give the app its status,
 * type and text. Redirects aren’t followed: the app sees the 3xx and its location. The whole fetch, from connecting to
 * the body’s last byte, has ms to finish, or it’s cut off with a 504. Past the limits on fetches at once and a minute
 * (server/net-fetch-limits.mjs), it’s refused with a 429 before anything leaves.
 * @param {{ url?: unknown }} args
 * @param {{ app?: string, ms?: number }} [opts]  the app whose fetch it is, and the deadline, shorter only in tests
 */
export async function netFetch({ url } = {}, { app = '', ms = NET_FETCH.seconds * 1000 } = {}) {
  const u = fetchableUrl(url);
  const end = LIMITS.admit(app);
  try {
    return await get(u, ms);
  } finally {
    end();
  }
}

/** One GET, with no cookies or credentials, cut off at the deadline. @param {URL} u @param {number} ms */
function get(u, ms) {
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { 'user-agent': 'Postbox-app-fetch', accept: '*/*' };
    const deadline = setTimeout(() => {
      reject(httpError(504, `net.fetch gave up after ${ms / 1000} seconds.`));
      req.destroy();
    }, ms);
    deadline.unref();
    const req = lib.get(u, { agent: AGENTS[u.protocol], lookup: guardedLookup(allowed().has(u.host)), headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= NET_FETCH.bytes) return chunks.push(c);
        reject(httpError(413, 'net.fetch reads at most 1 MB.'));
        req.destroy();
      });
      res.on('error', (e) => reject(httpError(502, `net.fetch failed: ${e.message}`)));
      res.on('close', () => clearTimeout(deadline));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          type: String(res.headers['content-type'] ?? ''),
          ...(res.headers.location ? { location: res.headers.location } : {}),
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', (/** @type {NodeJS.ErrnoException} */ e) => {
      clearTimeout(deadline);
      reject(e.code === 'EPRIVATE' ? httpError(403, `net.fetch refused it: ${e.message}`) : httpError(502, `net.fetch failed: ${e.message}`));
    });
  });
}
