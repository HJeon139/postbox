// Waits for a condition across the event loop's turns, for tests whose mock timers fake setTimeout, setInterval or Date.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

/**
 * Yields to the event loop until `fn` holds, or fails after `ms` of real time. The bound is
 * `performance.now()`, which mock timers leave alone, so a slow step under a parallel run (an
 * adapter's file I/O before it spawns) gets real time, not a count of turns.
 * @param {() => unknown} fn @param {string} label @param {number} [ms]
 */
export async function until(fn, label, ms = 10_000) {
  const end = performance.now() + ms;
  while (!fn() && performance.now() < end) await new Promise((r) => setImmediate(r));
  assert.ok(fn(), `Timed out waiting for ${label}`);
}
