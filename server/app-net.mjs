// Network for agent apps (prototype, designs/prototypes/flexible-apps.md, “Isolation and network”). Three variants to
// measure against today’s sandbox, chosen when Postbox starts:
// - POSTBOX_APP_NET=net   (A) the sandboxed, opaque-origin page may fetch, and load scripts, styles, fonts and images
//                             from anywhere.
// - POSTBOX_APP_NET=open  (B) the page is served with no sandbox: it’s same-origin with Postbox’s own page.
// - POSTBOX_APP_FETCH=1   (C) postbox.query('net.fetch', { url }) fetches through Postbox’s server: GET only, no
//                             cookies, and never an address on this computer or the local network.
// Anything else is today’s sandbox, which loads nothing.

import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { httpError } from './helpers.mjs';

/** @returns {'sandbox' | 'net' | 'open'} */
export function appNetMode() {
  const m = process.env.POSTBOX_APP_NET;
  return m === 'net' || m === 'open' ? m : 'sandbox';
}
export const appFetchOn = () => process.env.POSTBOX_APP_FETCH === '1';

/**
 * The policy for variant A: today’s, with the network opened. `sandbox allow-scripts` stays, so the origin is still
 * opaque. @param {string} ancestor
 */
export function netCsp(ancestor) {
  return [
    'sandbox allow-scripts allow-forms',
    "default-src 'none'",
    "script-src 'unsafe-inline' https: http:",
    "style-src 'unsafe-inline' https: http:",
    'img-src data: blob: https: http:',
    'media-src blob: https: http:',
    'font-src data: https: http:',
    'connect-src *',
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${ancestor}`,
  ].join('; ');
}

// ── C: a fetch through Postbox ─────────────────────────────────────────────────────────

const FETCH_BYTES = 1024 * 1024;
const FETCH_MS = 10_000;

/** Whether an IP address is this computer’s, the local network’s, or otherwise not on the public internet. */
export function privateAddress(ip) {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const x = ip.toLowerCase();
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || /^fe[89ab]/.test(x) || x.startsWith('ff');
}

/**
 * Hosts the demo treats as public, so the local stand-in for “another site” can be fetched: POSTBOX_FETCH_ALLOW,
 * host:port, comma-separated. Only for measuring; nothing sets it by default.
 */
const allowed = () => new Set((process.env.POSTBOX_FETCH_ALLOW ?? '').split(',').filter(Boolean));

/**
 * A DNS lookup that refuses a private address, so a name that resolves to one is refused where the socket connects,
 * and a second lookup can’t swap one in (DNS rebinding). @param {boolean} anyAddress  the host is on the allow list
 */
const guardedLookup = (anyAddress) => (host, opts, cb) =>
  lookup(host, { ...opts, all: false }, (err, address, family) => {
    if (err) return cb(err);
    if (!anyAddress && privateAddress(address)) return cb(Object.assign(new Error(`${host} is a private address (${address}).`), { code: 'EPRIVATE' }));
    cb(null, address, family);
  });

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
