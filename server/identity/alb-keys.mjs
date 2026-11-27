// The public keys a hosted Postbox checks sign-in tokens with (designs/architecture/hosted.md, “The check, whole”;
// server/identity/alb-token.mjs makes the check). An Application Load Balancer names the key it signed with by a key
// id, and its region serves that key at a fixed address. The region comes from the deployment’s configuration, never
// from a token, and the token’s check has already held the key id to a key id’s shape, and the token to this
// deployment’s own load balancer, before it asks here.
//
// The port is open to whatever the network lets reach it, and a key id is one of 2^122, so what a flood of made-up ids
// can make Postbox do is bounded four ways:
//   - a key is kept once had, and one in use stays kept, so made-up ids the endpoint has no key for can’t shut it out;
//   - a key id whose lookup failed isn’t looked up again for a minute;
//   - lookups of ids not yet had are bounded over time: so many in any minute, however many ids are tried;
//   - lookups in flight are bounded at once, and what is remembered is bounded.
// What a flood can still do, if it reaches the port without the load balancer and names its ARN, client and issuer:
// take each lookup as the minute frees it, so a key Postbox hasn’t had yet (just after a start, after the load balancer
// changes its key, or after other load balancers’ key ids have pushed it out while unused) is refused for as long as
// the flood lasts. People whose key is kept are unaffected. The deployment’s network rules are what close that
// (designs/architecture/hosted.md, “What it costs”).
//
// It fetches nothing itself: the caller gives it `get`, so nothing here reaches the network in a test. Today that is
// `start()`’s `signIn` option; the real fetch, with its timeout and size bound, is its own change.
//
// Not confirmed: the form the endpoint serves a key in. Its documentation doesn’t say (read 26 November 2026). An
// answer that isn’t a P-256 public key is handed back once, so the check can say it was the key’s form and not its
// absence, and is never kept: a surprise there refuses every request rather than letting one in. It is confirmed
// against a real load balancer in the deployment slice. Other partitions (GovCloud, China) serve keys at other
// addresses, also unconfirmed, so their regions are refused here until one is needed.

import { p256Key } from './alb-token.mjs';

/** A region of AWS’s main partition, such as us-west-2: all that may go into the endpoint’s host. */
export const REGION = /^(?!cn-)[a-z]{2}-[a-z]+-\d$/;
/** How long a key id whose lookup failed isn’t looked up again, and the span lookups are counted over. */
const MINUTE_MS = 60_000;
/** How many lookups may be in flight at once, how many may start in a minute, and how many keys and failures are remembered. */
const IN_FLIGHT = 8;
const PER_MINUTE = 16;
const KEPT = 32;

/** Puts a value under a key, letting go of the oldest past `most`. @param {Map<string, any>} map */
function remember(map, key, value, most) {
  map.delete(key);
  map.set(key, value);
  while (map.size > most) map.delete(/** @type {string} */ (map.keys().next().value));
}

/**
 * A way from a key id to its public key, for this deployment’s region.
 * @param {{ region: string, get: (url: string) => Promise<string>, now?: () => number, inFlight?: number, perMinute?: number, kept?: number }} deployment
 *   get: fetches a URL’s text, rejecting on any answer but 200 and when it can’t
 * @returns {(kid: string) => Promise<string | null>}  the key as the endpoint gave it, or null when there is none to be had now
 */
export function albKeys({ region, get, now = Date.now, inFlight = IN_FLIGHT, perMinute = PER_MINUTE, kept = KEPT }) {
  if (typeof region !== 'string' || !REGION.test(region))
    throw new Error('The sign-in check needs the deployment’s AWS region, such as us-west-2, to find the load balancer’s keys.');
  /** @type {Map<string, string>} */
  const keys = new Map();
  /** @type {Map<string, number>}  key id → when its lookup failed */
  const failed = new Map();
  /** @type {Map<string, Promise<string | null>>} */
  const asking = new Map();
  /** When each lookup of the last minute started. @type {number[]} */
  let started = [];

  const lookUp = async (/** @type {string} */ kid) => {
    try {
      const key = (await get(`https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`)).trim();
      if (!key) throw new Error('The endpoint answered with nothing.');
      // Kept only if it is a key: an error’s text answered in a key’s place is handed back this once and waits as a failure.
      if (p256Key(key)) remember(keys, kid, key, kept);
      else remember(failed, kid, now(), kept);
      return key;
    } catch {
      // Whatever the reason, there is no key to check with now: the request is refused, and this id waits.
      remember(failed, kid, now(), kept);
      return null;
    }
  };

  return async (kid) => {
    const key = keys.get(kid);
    if (key) {
      // In use, so it becomes the newest: other key ids the endpoint answers let go of the key used longest ago.
      remember(keys, kid, key, kept);
      return key;
    }
    const failedAt = failed.get(kid);
    if (failedAt !== undefined && now() - failedAt < MINUTE_MS) return null;
    const shared = asking.get(kid);
    if (shared) return shared;
    // Too many lookups already, at once or in the last minute: this request is refused, and its id isn’t held against it.
    started = started.filter((at) => now() - at < MINUTE_MS);
    if (asking.size >= inFlight || started.length >= perMinute) return null;
    started.push(now());
    // Let go of once it settles, whichever way, and only after it is held: a getter that throws at once settles first.
    const asked = lookUp(kid).finally(() => asking.delete(kid));
    asking.set(kid, asked);
    return asked;
  };
}
