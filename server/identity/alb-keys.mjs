// The public keys a hosted Postbox checks sign-in tokens with (designs/architecture/hosted.md, “The check, whole”;
// server/identity/alb-token.mjs makes the check). An Application Load Balancer names the key it signed with by a key
// id, and its region serves that key at a fixed address. The region comes from the deployment’s configuration, never
// from a token, and the token’s check has already held the key id to a key id’s shape before it asks here.
//
// A key is kept once had. A lookup that fails is remembered for a while, and lookups in flight are bounded: the port
// is open to whatever the network lets reach it, and without both a request with a made-up key id would make Postbox
// call out on every request. What is remembered is bounded too.
//
// It fetches nothing itself: the caller gives it `get`, so nothing here reaches the network in a test, and the
// provider that wires this in chooses how (its own change).
//
// Not confirmed: the form the endpoint serves a key in. Its documentation doesn’t say (read 27 November 2026). The check
// takes whatever Node reads as a public key, PEM text among them, and refuses anything that isn’t a P-256 key, so a
// surprise there refuses every request rather than letting one in. It is confirmed against a real load balancer
// in the deployment slice.

/** An AWS region’s name, such as us-west-2 or us-gov-west-1: all that may go into the endpoint’s host. */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
/** How long a key id whose lookup failed isn’t looked up again. */
const FAILED_FOR_MS = 60_000;
/** How many lookups may be in flight at once, and how many keys and failures are remembered. */
const IN_FLIGHT = 8;
const KEPT = 32;

/** Puts a value under a key, letting go of the oldest past `most`. @param {Map<string, any>} map */
function remember(map, key, value, most) {
  map.delete(key);
  map.set(key, value);
  while (map.size > most) map.delete(/** @type {string} */ (map.keys().next().value));
}

/**
 * A way from a key id to its public key, for this deployment’s region.
 * @param {{ region: string, get: (url: string) => Promise<string>, now?: () => number, inFlight?: number, kept?: number }} deployment
 *   get: fetches a URL’s text, rejecting when it can’t
 * @returns {(kid: string) => Promise<string | null>}  the key as the endpoint gave it, or null when there is none to be had now
 */
export function albKeys({ region, get, now = Date.now, inFlight = IN_FLIGHT, kept = KEPT }) {
  if (typeof region !== 'string' || !REGION.test(region))
    throw new Error('The sign-in check needs the deployment’s AWS region, such as us-west-2, to find the load balancer’s keys.');
  /** @type {Map<string, string>} */
  const keys = new Map();
  /** @type {Map<string, number>}  key id → when its lookup failed */
  const failed = new Map();
  /** @type {Map<string, Promise<string | null>>} */
  const asking = new Map();

  const lookUp = async (/** @type {string} */ kid) => {
    try {
      const key = (await get(`https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`)).trim();
      if (!key) throw new Error('The endpoint answered with nothing.');
      remember(keys, kid, key, kept);
      return key;
    } catch {
      // Whatever the reason, there is no key to check with now: the request is refused, and this id waits.
      remember(failed, kid, now(), kept);
      return null;
    }
  };

  return async (kid) => {
    const key = keys.get(kid);
    if (key) return key;
    const failedAt = failed.get(kid);
    if (failedAt !== undefined && now() - failedAt < FAILED_FOR_MS) return null;
    const shared = asking.get(kid);
    if (shared) return shared;
    // Too many lookups already: this request is refused, and its id isn’t held against it.
    if (asking.size >= inFlight) return null;
    // Let go of once it settles, whichever way, and only after it is held: a getter that throws at once settles first.
    const asked = lookUp(kid).finally(() => asking.delete(kid));
    asking.set(kid, asked);
    return asked;
  };
}
