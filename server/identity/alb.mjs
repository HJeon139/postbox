// The AWS identity provider (#558, prototype): an Application Load Balancer signs each person in (its
// authenticate-oidc or authenticate-cognito action, so OIDC directly and SAML through a Cognito user pool) and passes
// who they are in `x-amzn-oidc-data`, a JWT it signs with ES256. Postbox holds no client secret and runs no sign-in
// flow: it verifies that header on every request, with node:crypto alone.
//
// What is checked, as AWS’s “Authenticate users using an Application Load Balancer” requires:
//   - the algorithm is ES256, and nothing else (no `none`, no key confusion);
//   - `signer` is the ARN of the load balancer configured here, so another account’s balancer can’t vouch for anyone;
//   - the signature, against the regional public key named by `kid`, before any claim is read;
//   - `exp`. The unsigned x-amzn-oidc-identity and -accesstoken headers are never read.
// The segments are base64url with padding, unlike a standard JWT; the signature covers them exactly as sent.

import { createPublicKey, verify } from 'node:crypto';
import { httpError } from '../helpers.mjs';

const KID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX = 16 * 1024; // the balancer refuses claims past 11 KB
const KEYS = 8;
const LEEWAY = 60; // seconds of clock difference allowed on exp

const unauthorized = (/** @type {string} */ why) =>
  Object.assign(httpError(401, `Postbox couldn’t tell who you are: ${why}. Open Postbox through its sign-in address.`), { code: 'identity' });

const part = (/** @type {string} */ s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
const text = (/** @type {unknown} */ v, n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);

async function fetchPem(/** @type {string} */ url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!r.ok) throw new Error(`the key answered ${r.status}`);
  return r.text();
}

/**
 * @param {{ signer: string, region?: string, keyUrl?: (kid: string) => string, fetchKey?: (url: string) => Promise<string>, now?: () => number }} config
 *   signer: the load balancer’s ARN. keyUrl and fetchKey: for tests and the demo’s stand-in balancer.
 * @returns {(req: import('node:http').IncomingMessage) => Promise<import('./index.mjs').Principal>}
 */
export function albIdentity({ signer, region, keyUrl, fetchKey = fetchPem, now = Date.now }) {
  if (!signer) throw new Error('The load balancer’s ARN is needed (POSTBOX_ALB_SIGNER), or anyone’s balancer could sign a person in.');
  const urlOf = keyUrl ?? ((kid) => `https://public-keys.auth.elb.${region ?? signer.split(':')[3]}.amazonaws.com/${kid}`);
  /** @type {Map<string, import('node:crypto').KeyObject>} */
  const keys = new Map();
  const keyFor = async (/** @type {string} */ kid) => {
    const had = keys.get(kid);
    if (had) return had;
    const key = createPublicKey(await fetchKey(urlOf(kid)));
    if (keys.size >= KEYS) keys.delete(keys.keys().next().value ?? '');
    keys.set(kid, key);
    return key;
  };
  return async function identify(req) {
    const jwt = req.headers['x-amzn-oidc-data'];
    if (typeof jwt !== 'string') throw unauthorized('the request didn’t come through the load balancer');
    const segments = jwt.split('.');
    if (jwt.length > MAX || segments.length !== 3) throw unauthorized('its signed identity is malformed');
    const [h, p, s] = segments;
    let header;
    try {
      header = part(h);
    } catch {
      throw unauthorized('its signed identity is malformed');
    }
    if (header?.alg !== 'ES256') throw unauthorized('its identity isn’t signed with ES256');
    if (header.signer !== signer) throw unauthorized('its identity was signed by a different load balancer');
    if (typeof header.kid !== 'string' || !KID.test(header.kid)) throw unauthorized('its signing key has no valid id');
    let key;
    try {
      key = await keyFor(header.kid);
    } catch (e) {
      throw unauthorized(`the load balancer’s public key couldn’t be read (${/** @type {Error} */ (e).message})`);
    }
    if (!verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')))
      throw unauthorized('its identity’s signature doesn’t match');
    const claims = part(p);
    if (!(typeof claims.exp === 'number' && claims.exp + LEEWAY > now() / 1000)) throw unauthorized('the sign-in has expired');
    const subject = text(claims.sub);
    const issuer = text(claims.iss ?? header.iss, 500);
    if (!subject || !issuer) throw unauthorized('its identity names no issuer or subject');
    const email = text(claims.email);
    return {
      provider: 'alb',
      issuer,
      subject,
      username: text(claims.preferred_username) ?? text(claims['cognito:username']) ?? text(claims.username) ?? email ?? subject,
      name: text(claims.name) ?? text(claims.preferred_username) ?? email?.split('@')[0] ?? subject,
      ...(email ? { email } : {}),
    };
  };
}
