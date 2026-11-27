// The sign-in check of a hosted Postbox (designs/architecture/hosted.md, “Who is asking”, “The check, whole”). On
// AWS an Application Load Balancer signs people in and forwards each request with the person’s claims in
// `x-amzn-oidc-data`, a token it signs. Postbox’s port is reachable by whatever the network lets reach it, so this
// check, made on every request, is the boundary: a token is a person’s only when every part below holds, and a
// failure of any part refuses the request.
//
// What the load balancer sends is in its documentation, “Authenticate users using an Application Load Balancer”
// (https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html, read 26
// November 2026): the token’s header carries `alg`, `kid`, `signer`, `iss`, `client` and `exp`, its payload the
// claims of the identity provider’s user info, its parts are base64url with their padding kept, and it is signed
// with ES256.
//
// The provider (server/identity/alb.mjs) calls it on every request of a Postbox given sign-in settings. It reads no
// header itself and fetches nothing: the caller hands it the token and a way to a key (server/identity/alb-keys.mjs).

import { createPublicKey, createVerify } from 'node:crypto';

/** A key id as the load balancer writes one: checked before it is looked up, since a lookup puts it in a URL. */
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One part of a token: base64url, with or without the padding the load balancer keeps. */
const PART = /^[A-Za-z0-9_-]+={0,2}$/;
/** An ES256 signature: r and s, 32 bytes each. */
const SIGNATURE_BYTES = 64;

/**
 * Why a token was refused, for the server’s own log and the tests. What a person is shown never says which: a
 * request with no sign-in learns only that it needs one.
 * `key` is no key to be had; `key-form` is an answer that isn’t a P-256 public key, which is how a surprise in the form
 * the endpoint serves keys in would read.
 * @typedef {'malformed' | 'algorithm' | 'key-id' | 'signer' | 'client' | 'issuer' | 'key' | 'key-form' | 'signature' | 'no-expiry' | 'expired' | 'subject'} Refusal
 */

/** @param {Refusal} code @param {unknown} [cause] */
function refuse(code, cause) {
  const message = 'Sign in to use this Postbox.';
  return Object.assign(new Error(message, { cause }), { status: 401, userMessage: message, code });
}

/** A part of the token as the JSON object it holds, or nothing. @param {string} part */
function objectOf(part) {
  if (!PART.test(part)) return null;
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null; // not JSON: not a token
  }
}

/** The key a lookup answered with, if it is a P-256 public key; else nothing. @param {unknown} found */
export function p256Key(found) {
  try {
    const key = createPublicKey(/** @type {any} */ (found));
    return key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null; // only an EC key has a curve
  } catch {
    return null; // not a key at all
  }
}

/** When the token stops being good, in seconds since 1970, from a number or a string of digits; else nothing. @param {unknown} exp */
function expiryOf(exp) {
  const seconds = typeof exp === 'string' && /^\d+(\.\d+)?$/.test(exp) ? Number(exp) : exp;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Checks the token the load balancer forwarded, and answers who it is for.
 *
 * In order: it is three parts of JSON; its algorithm is ES256, whatever it claims; its key id has a key id’s shape;
 * its signer, client and issuer are this deployment’s. Those three are read before the signature is checked, and
 * that believes nothing: a token is refused for them, never accepted, and acceptance still needs the signature over
 * the same bytes. They come first so that a request has to name this deployment’s own load balancer before Postbox
 * looks a key up for it at all. Then the key looked up is a P-256 key, and the signature is that key’s over the first
 * two parts. Then, from the header the signature covers, it hasn’t expired, and the payload names a subject.
 *
 * @param {unknown} sent  the header’s value, as the request carried it
 * @param {{ signer: string, client: string, issuer: string, now?: () => number,
 *           keyOf: (kid: string) => Promise<unknown> }} deployment
 *   signer: the load balancer’s ARN; client and issuer: the application’s client id and the identity provider, since
 *   one load balancer can front several applications and a token minted for another verifies against the same key;
 *   keyOf: the public key for a key id (PEM text or a key object), or nothing when there is none
 * @returns {Promise<{ issuer: string, subject: string, claims: Record<string, unknown>, until: number }>}  until: when the token stops being good, in ms
 */
export async function checkAlbToken(sent, { signer, client, issuer, keyOf, now = Date.now }) {
  for (const [name, value] of Object.entries({ signer, client, issuer }))
    if (typeof value !== 'string' || !value) throw new Error(`The sign-in check needs the deployment’s ${name}, and has none.`);

  const parts = typeof sent === 'string' ? sent.split('.') : [];
  if (parts.length !== 3) throw refuse('malformed');
  const [header, payload] = [objectOf(parts[0]), objectOf(parts[1])];
  if (!header || !payload) throw refuse('malformed');

  if (header.alg !== 'ES256') throw refuse('algorithm');
  if (typeof header.kid !== 'string' || !KEY_ID.test(header.kid)) throw refuse('key-id');
  if (header.signer !== signer) throw refuse('signer');
  if (header.client !== client) throw refuse('client');
  if (header.iss !== issuer) throw refuse('issuer');

  // However the lookup fails, by answering nothing, rejecting or throwing as it is called, there is no key.
  const found = await Promise.resolve()
    .then(() => keyOf(header.kid))
    .catch((e) => Promise.reject(refuse('key', e)));
  if (found === null || found === undefined) throw refuse('key');
  const key = p256Key(found);
  if (!key) throw refuse('key-form');

  const signature = Buffer.from(parts[2], 'base64url');
  const signed = `${parts[0]}.${parts[1]}`;
  if (signature.length !== SIGNATURE_BYTES || !createVerify('SHA256').update(signed).verify({ key, dsaEncoding: 'ieee-p1363' }, signature))
    throw refuse('signature');

  const expiry = expiryOf(header.exp);
  if (expiry === null) throw refuse('no-expiry');
  if (expiry * 1000 <= now()) throw refuse('expired');
  if (typeof payload.sub !== 'string' || !payload.sub) throw refuse('subject');

  return { issuer, subject: payload.sub, claims: payload, until: expiry * 1000 };
}
