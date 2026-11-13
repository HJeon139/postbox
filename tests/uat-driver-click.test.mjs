// #1320: the UAT driver clicks where an element is when it clicks, as a person aims at what they see, and a Save that
// didn't take fails the step. A stand-in page answers the driver’s expressions and records its mouse events; node:test’s
// mock timers stand in for the driver’s waits.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { driver } from '../tools/uat/driver.mjs';
import { placePersona } from '../tools/uat/driver-hosts.mjs';

/**
 * A page whose element is at each of `centers` in turn, one per measurement, staying at the last; and that answers
 * anything else with `other(expr)`.
 * @param {{ x: number, y: number }[]} centers @param {(expr: string) => any} [other]
 */
function standIn(centers, other = () => true) {
  const clicks = [];
  let measured = 0;
  const page = {
    evaluate: async (/** @type {string} */ expr) => {
      if (expr.includes('getBoundingClientRect')) return centers[Math.min(measured++, centers.length - 1)];
      return other(expr);
    },
    frameOf: async () => null,
    send: async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') clicks.push({ x: params.x, y: params.y });
      return { data: '' };
    },
  };
  return { page, clicks };
}

/** Runs fn with the driver’s sleeps run at once. @param {import('node:test').TestContext} t */
async function fast(t, fn) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let done = false;
  const run = fn().finally(() => {
    done = true;
  });
  // Handled now, though the caller reads it only once the loop ends: a rejection unhandled meanwhile fails the test.
  run.catch(() => {});
  while (!done) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.runAll();
  }
  return run;
}

test('#1320 clickAt clicks where a button is after its pause, not where it was when it aimed', async (t) => {
  // Save moved 16.8 px down while the Model field’s help went from one line to two.
  const { page, clicks } = standIn([
    { x: 364.5, y: 1066.3 },
    { x: 364.5, y: 1083.1 },
    { x: 364.5, y: 1083.1 },
  ]);
  await fast(t, () => driver(page).clickAt(`document.querySelector('#save')`, 'Save'));
  assert.deepEqual(clicks, [{ x: 364.5, y: 1083.1 }]);
});

test('#1320 clickAt waits for a button that keeps moving to hold still before it clicks', async (t) => {
  const { page, clicks } = standIn([
    { x: 10, y: 100 },
    { x: 10, y: 110 },
    { x: 10, y: 120 },
    { x: 10, y: 120 },
  ]);
  await fast(t, () => driver(page).clickAt(`document.querySelector('#save')`, 'Save'));
  assert.deepEqual(clicks, [{ x: 10, y: 120 }]);
});

test('#1320 placePersona fails, saying so, when Save didn’t close the editor', async (t) => {
  // Every element is there, and the editor never closes: Save didn’t take.
  const { page } = standIn([{ x: 10, y: 10 }], (expr) => (expr.includes("getElementById('pe-where-err')") ? null : true));
  const { kit } = driver(page);
  await assert.rejects(
    fast(t, () => placePersona(kit, 'coder', 'ho_1')),
    /@coder’s editor is still open after Save/,
  );
});
