// net.fetch { url }: public data for an agent app, fetched by Postbox’s server (designs/architecture/sandbox.md, “Network
// through Postbox”; designs/architecture/security-boundaries.md, “What leaves through net.fetch”). The app’s own frame
// stays sandboxed and loads nothing. This sends no cookies or credentials, only GETs, follows no redirect, and never
// reaches this computer or the local network: an address is checked after DNS resolution, where the socket connects.

import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { httpError } from './helpers.mjs';
import { guardedLookup, privateAddress } from './net-address.mjs';

const FETCH_BYTES = 1024 * 1024;
const FETCH_MS = 10_000;

/**
 * Hosts the demo treats as public, so the local stand-in for “another site” can be fetched: POSTBOX_FETCH_ALLOW,
 * host:port, comma-separated. Only for measuring; nothing sets it by default.
 */
const allowed = () => new Set((process.env.POSTBOX_FETCH_ALLOW ?? '').split(',').filter(Boolean));

/**
 * net.fetch { url }: GET a public URL from Postbox’s server, with no cookies or credentials, and give the app its status,
 * type and text. Redirects aren’t followed: the app sees the 3xx and its location. @param {{ url?: unknown }} args
 */
export async function netFetch({ url } = {}) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw httpError(400, 'net.fetch needs an absolute http or https URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw httpError(400, 'net.fetch fetches only http and https URLs.');
  if (u.username || u.password) throw httpError(400, 'net.fetch sends no credentials, so a URL can’t carry them.');
  const listed = allowed().has(u.host);
  const bare = u.hostname.replace(/^\[|\]$/g, '');
  if (!listed && (u.hostname === 'localhost' || (isIP(bare) && privateAddress(bare))))
    throw httpError(403, `net.fetch refused ${u.host}: it’s on this computer or the local network.`);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(u, { lookup: guardedLookup(listed), headers: { 'user-agent': 'Postbox-app-fetch', accept: '*/*' }, timeout: FETCH_MS }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > FETCH_BYTES) {
          req.destroy();
          reject(httpError(413, 'net.fetch reads at most 1 MB.'));
        } else chunks.push(c);
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          type: String(res.headers['content-type'] ?? ''),
          ...(res.headers.location ? { location: res.headers.location } : {}),
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('timeout', () => req.destroy(httpError(504, 'net.fetch gave up after 10 seconds.')));
    req.on('error', (/** @type {NodeJS.ErrnoException} */ e) =>
      reject(e.code === 'EPRIVATE' ? httpError(403, `net.fetch refused it: ${e.message}`) : httpError(502, `net.fetch failed: ${e.message}`)),
    );
  });
}
