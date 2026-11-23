// What the run-bound tests share (tools/uat/run-bound.mjs): a clock they move on, and a session as /api/state gives it.

/** A clock that starts at a fixed time and moves only when told. */
export const clock = () => {
  let t = 1_000_000;
  return { now: () => t, pass: (/** @type {number} */ minutes) => (t += minutes * 60000) };
};

/** A session at `state`, on its turn `turn`, on a backend: the bound reads only the first three. */
export const se = (id, turn, state = 'idle', backend = 'claude-code') => ({ id, handle: id, lastTurnId: turn, state, backend });
