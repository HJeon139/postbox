// How many fetches net.fetch runs at once and how often (server/net-fetch-limits.mjs): per app, in all, and per minute.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FetchLimits } from '../server/net-fetch-limits.mjs';

const LIMITS = { bytes: 1, seconds: 1, perApp: 2, total: 3, perMinute: 5 };

test('one app has at most perApp fetches open; one ending lets the next in', () => {
  const limits = new FetchLimits({ now: () => 0, limits: LIMITS });
  const first = limits.admit('a');
  limits.admit('a');
  assert.throws(
    () => limits.admit('a'),
    (e) => e.status === 429 && /at once for one app/.test(e.message),
  );
  first();
  first(); // ending twice frees one place, not two
  limits.admit('a');
  assert.throws(
    () => limits.admit('a'),
    (e) => e.status === 429,
  );
});

test('all apps together have at most total fetches open', () => {
  const limits = new FetchLimits({ now: () => 0, limits: LIMITS });
  limits.admit('a');
  limits.admit('b');
  const third = limits.admit('c');
  assert.throws(
    () => limits.admit('d'),
    (e) => e.status === 429 && /at most 3 fetches at once\./.test(e.message),
  );
  third();
  limits.admit('d');
});

test('one app starts at most perMinute fetches a minute, counted from each start', () => {
  let now = 0;
  const limits = new FetchLimits({ now: () => now, limits: { ...LIMITS, perApp: 99, total: 99 } });
  for (let i = 0; i < 5; i++) limits.admit('a')();
  assert.throws(
    () => limits.admit('a'),
    (e) => e.status === 429 && /a minute/.test(e.message),
  );
  limits.admit('b');
  now = 59_999;
  assert.throws(
    () => limits.admit('a'),
    (e) => e.status === 429,
  );
  now = 60_000;
  limits.admit('a');
});
