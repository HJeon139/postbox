// The budget spec’s paced input (#1166, tests/browser/budget.spec.mjs). A measure presses keys, or adds messages, at
// a fixed interval, as a person types or a room fills, and lets the page sit idle for a set time to calibrate its
// frame probe. Those waits are what’s measured, not waits for a condition, so they live here, outside the browser
// specs’ rule against fixed waits (tools/biome/no-fixed-waits.grit).

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs each step at its own time, everyMs apart from the first, however long a step takes, so a slow page isn’t
 * given more time between inputs than a fast one.
 * @param {number} count  @param {number} everyMs  @param {(i: number) => Promise<unknown>} step
 */
export async function paced(count, everyMs, step) {
  const start = Date.now();
  for (let i = 0; i < count; i++) {
    await sleep(Math.max(0, start + i * everyMs - Date.now()));
    await step(i);
  }
}

/** Lets the page sit idle for ms, as the frame probe’s calibration measures it. @param {number} ms */
export const idleFor = (ms) => sleep(ms);
