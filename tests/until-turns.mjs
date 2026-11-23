// A wait for tests whose timers are mocked (node:test’s mock.timers), so no setTimeout or Date can bound it. It spins
// the event loop’s turns, and real time ends it: under a parallel `node --test` load, a fixed count of turns ran out
// before a fake CLI’s file I/O did (#1526, the integrator’s review of #1592). performance.now() isn’t mocked.
// Don’t add setImmediate to mock.timers in a test that calls it: the await below would never return, and the
// deadline couldn’t end the wait.

import assert from 'node:assert/strict';

/** How long a wait may take, in real milliseconds, before the test fails. */
export const UNTIL_MS = 10_000;

/** Waits on the event loop’s turns, ended by real time, until `fn` holds. */
export async function untilTurns(fn, label) {
  const end = performance.now() + UNTIL_MS;
  while (!fn() && performance.now() < end) await new Promise((r) => setImmediate(r));
  assert.ok(fn(), `Timed out waiting for ${label}`);
}
