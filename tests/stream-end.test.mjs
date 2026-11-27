// A hosted Postbox’s event stream ends when its sign-in does (server/identity/stream-end.mjs), and the provider says
// when that is (server/identity/alb.mjs). The clock and the timer are fakes.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { albProvider } from '../server/identity/alb.mjs';
import { signInSettings } from '../server/identity/sign-in-settings.mjs';
import { endAt } from '../server/identity/stream-end.mjs';
import { NOW, publicPem, SETTINGS, tokenFor } from './alb-fixture.mjs';

/** A request that records its end, and a timer that fires when told. */
function fakes() {
  const req = Object.assign(new EventEmitter(), { destroyed: 0, destroy: () => req.destroyed++ });
  /** @type {{ run: () => void, ms: number, cleared: boolean }[]} */
  const timers = [];
  const setTimer = (/** @type {() => void} */ run, /** @type {number} */ ms) => timers[timers.push({ run, ms, cleared: false }) - 1];
  const clearTimer = (/** @type {any} */ timer) => {
    timer.cleared = true;
  };
  return { req, timers, clock: { now: () => NOW, setTimer: /** @type {any} */ (setTimer), clearTimer: /** @type {any} */ (clearTimer) } };
}

test('a stream’s connection is ended when its token stops being good, and not before', () => {
  const { req, timers, clock } = fakes();
  endAt(/** @type {any} */ (req), NOW + 90_000, clock);
  assert.deepEqual([timers[0].ms, req.destroyed], [90_000, 0]);
  timers[0].run();
  assert.equal(req.destroyed, 1);
});

test('a stream that closed first leaves no timer behind, and a token already past ends it at once', () => {
  const { req, timers, clock } = fakes();
  endAt(/** @type {any} */ (req), NOW + 90_000, clock);
  req.emit('close');
  assert.equal(timers[0].cleared, true);
  endAt(/** @type {any} */ (req), NOW - 5, clock);
  assert.equal(timers[1].ms, 0);
});

test('the provider says when a person’s sign-in ends: the token’s exp, read from under its signature', async () => {
  const identify = albProvider(signInSettings(SETTINGS), { get: async () => publicPem, now: () => NOW });
  const who = await identify(/** @type {any} */ ({ headers: { 'x-amzn-oidc-data': tokenFor({ header: { exp: NOW / 1000 + 45 } }) } }));
  assert.equal(who.until, NOW + 45_000);
});

test('an email address that names a person must be one the provider verified', async () => {
  const settings = signInSettings({ ...SETTINGS, claims: { username: 'email', name: 'name' } });
  const identify = albProvider(settings, { get: async () => publicPem, now: () => NOW });
  const ask = (/** @type {Record<string, unknown>} */ payload) => identify(/** @type {any} */ ({ headers: { 'x-amzn-oidc-data': tokenFor({ payload }) } }));
  for (const email_verified of [undefined, false, 'false', 'yes', 1]) await assert.rejects(ask({ email_verified }), { status: 403, code: 'unverified' });
  for (const email_verified of [true, 'true']) assert.equal((await ask({ email_verified })).username, 'robin@example.com');
  // Where no claim Postbox reads is the email address, whether it is verified names no one, so it isn’t asked.
  const other = albProvider(signInSettings(SETTINGS), { get: async () => publicPem, now: () => NOW });
  assert.equal((await other(/** @type {any} */ ({ headers: { 'x-amzn-oidc-data': tokenFor() } }))).username, 'robin');
});
