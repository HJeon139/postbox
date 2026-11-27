// The keys a hosted Postbox checks sign-in tokens with (designs/architecture/hosted.md, “The check, whole”): looked up
// by key id from the region’s endpoint, kept once had, and not asked for again for a while after a lookup fails, so a
// made-up key id can’t make Postbox call out on every request. The getter is a stand-in: no test reaches the network.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { albKeys } from '../server/identity/alb-keys.mjs';

const KID = '12345678-1234-1234-1234-123456789012';
const other = (/** @type {number} */ n) => `${String(n).padStart(8, '0')}-1234-1234-1234-123456789012`;

/** A key source over a getter that records what it was asked, and a clock the test moves. */
function keys(/** @type {(url: string) => Promise<string>} */ answer = async () => 'PEM', /** @type {Record<string, any>} */ over = {}) {
  const asked = [];
  const clock = { now: 1_000_000 };
  const keyOf = albKeys({
    region: 'us-west-2',
    get: (url) => {
      asked.push(url);
      return answer(url);
    },
    now: () => clock.now,
    ...over,
  });
  return { keyOf, asked, clock };
}

test('a key is looked up at its region’s endpoint by its id, once, and kept', async () => {
  const k = keys();
  assert.equal(await k.keyOf(KID), 'PEM');
  assert.equal(await k.keyOf(KID), 'PEM');
  assert.deepEqual(k.asked, [`https://public-keys.auth.elb.us-west-2.amazonaws.com/${KID}`]);
});

test('the region is the deployment’s, checked as it is given: one that isn’t a region’s name never reaches a URL', () => {
  for (const region of ['', 'us-west-2.evil.example', 'us-west-2/x', '../x', 'US-WEST-2', undefined])
    assert.throws(() => albKeys({ region: /** @type {any} */ (region), get: async () => 'PEM' }), /needs the deployment’s AWS region/);
  for (const region of ['us-west-2', 'eu-central-1', 'ap-southeast-4', 'us-gov-west-1']) albKeys({ region, get: async () => 'PEM' });
});

test('a lookup that fails, or answers with nothing, gives no key, and that id isn’t asked for again until a while has passed', async () => {
  let fail = true;
  const k = keys(async () => {
    if (fail) throw new Error('getaddrinfo ENOTFOUND');
    return 'PEM';
  });
  assert.equal(await k.keyOf(KID), null);
  assert.equal(await k.keyOf(KID), null);
  assert.equal(k.asked.length, 1, 'the second ask made no lookup');
  // Still remembered a moment before the wait ends, and asked again once it has.
  fail = false;
  k.clock.now += 59_999;
  assert.equal(await k.keyOf(KID), null);
  assert.equal(k.asked.length, 1);
  k.clock.now += 1;
  assert.equal(await k.keyOf(KID), 'PEM');
  assert.equal(k.asked.length, 2);
  // A getter that throws as it is called, not later, is a failed lookup like any other, and leaves nothing in flight.
  const thrower = keys(
    () => {
      throw new Error('bad URL');
    },
    { inFlight: 1 },
  );
  assert.equal(await thrower.keyOf(KID), null);
  thrower.clock.now += 60_000;
  assert.equal(await thrower.keyOf(KID), null);
  assert.equal(thrower.asked.length, 2, 'asked again once the wait has passed');
  // An empty answer is a failure too.
  const empty = keys(async () => '  ');
  assert.equal(await empty.keyOf(KID), null);
  assert.equal(await empty.keyOf(KID), null);
  assert.equal(empty.asked.length, 1);
});

/** What a call answers with if it has settled by the next turn of the loop, else “still asking”: a test never waits on a lookup that may never end. */
const soon = (/** @type {Promise<unknown>} */ asked) => Promise.race([asked, new Promise((resolve) => setImmediate(() => resolve('still asking')))]);

test('requests that arrive together for one key share one lookup', async () => {
  /** @type {((pem: string) => void)[]} */
  const waiting = [];
  const k = keys(() => new Promise((resolve) => waiting.push(resolve)));
  const both = [k.keyOf(KID), k.keyOf(KID)];
  assert.equal(await soon(both[1]), 'still asking');
  assert.equal(k.asked.length, 1, 'one lookup for the two');
  for (const done of waiting) done('PEM');
  assert.deepEqual(await Promise.all(both), ['PEM', 'PEM']);
});

test('lookups in flight are bounded: past the bound a new key id gets no key and makes no lookup, and isn’t remembered as failed', async () => {
  /** @type {((pem: string) => void)[]} */
  const waiting = [];
  const k = keys(() => new Promise((resolve) => waiting.push(resolve)), { inFlight: 2 });
  const first = [k.keyOf(other(1)), k.keyOf(other(2))];
  assert.equal(await soon(k.keyOf(other(3))), null, 'turned away at once, not left asking');
  assert.equal(k.asked.length, 2);
  for (const done of waiting) done('PEM');
  assert.deepEqual(await Promise.all(first), ['PEM', 'PEM']);
  // With room again, the id that was turned away is looked up: it never failed.
  const third = k.keyOf(other(3));
  assert.equal(await soon(third), 'still asking');
  assert.equal(k.asked.length, 3);
  waiting.at(-1)?.('PEM');
  assert.equal(await third, 'PEM');
});

test('what is remembered is bounded: the oldest key and the oldest failure make room for new ones', async () => {
  const k = keys(async (url) => (url.endsWith(other(99)) ? Promise.reject(new Error('no such key')) : 'PEM'), { kept: 2 });
  for (const n of [1, 2, 3]) await k.keyOf(other(n));
  assert.equal(k.asked.length, 3);
  await k.keyOf(other(3));
  await k.keyOf(other(2));
  assert.equal(k.asked.length, 3, 'the two newest are kept');
  await k.keyOf(other(1));
  assert.equal(k.asked.length, 4, 'the oldest was let go, and is looked up again');
});
