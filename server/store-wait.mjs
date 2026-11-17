// Work that waits for the store to take writes again (#508’s storage design, “When a write fails (ST-3)”): the queue
// server/store-outage.mjs runs once writes reopen. Moved from server/store-outage.mjs, so a module that only waits
// for writes doesn’t import the outage’s turn handling (#1442; #312 on import cycles).

/** @typedef {import('./runtime.mjs').Runtime} Runtime */

/**
 * Runs fn now if the store takes writes, else once it does. first: before what already waits, for a write any later
 * turn depends on, such as a backend’s session id. owner: the timer that would recreate this work from the recovered
 * state (a wake’s schedule id); the reload drops owned entries before it re-arms,
 * so each unit of work has one owner after Retry (S1, the integrator’s re-review of #598: a wake fired while closed was
 * delivered twice). @param {Runtime} rt @param {() => void} fn @param {{ first?: boolean, owner?: string }} [o]
 */
export function whenWritable(rt, fn, { first = false, owner } = {}) {
  if (rt.store.writable) return fn();
  const entry = owner ? Object.assign(() => fn(), { owner }) : fn;
  if (first) rt.storeWait.unshift(entry);
  else rt.storeWait.push(entry);
}
