// Killing a store’s Redis child in a test (tests/AGENTS.md, “The store’s Redis”). Once the child runs, nothing of it
// keeps the event loop alive: the supervisor unrefs it and its pipes, and an idle connection is unref’d too. A test
// that kills it and awaits only its exit, or the supervisor’s next status, may have nothing else in the loop; Node then
// exits before the kernel reports the death, and node:test cancels every pending test with “Promise resolution is
// still pending but the event loop has already resolved”, naming no cause. Linux reports a SIGKILLed child late enough
// for that every time (CI). So the wait here holds the loop, and fails naming the supervisor’s status instead of
// hanging when the child doesn’t go. It has no side effects, so a plain Node (tests/process/store-kill-child.mjs) can
// import it as a test file does through tests/store-fixture.mjs.

/**
 * Kills the store’s Redis child with SIGKILL and resolves once the supervisor has reported it down (its status left
 * `running`), holding the event loop meanwhile; rejects, naming the status, when that takes longer than `ms`.
 * @param {any} s  a Store on a data folder
 * @param {number} [ms]
 */
export function killed(s, ms = 5000) {
  const sup = s.redis.sup;
  const child = sup.child;
  if (!child || child.exitCode !== null || child.signalCode !== null)
    return Promise.reject(new Error(`The store’s Redis child isn’t running: ${JSON.stringify(sup.status)}`));
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => {
      sup.off('status', on);
      fail(new Error(`The store’s Redis child (pid ${child.pid}) wasn’t reported down within ${ms} ms of SIGKILL; status ${JSON.stringify(sup.status)}`));
    }, ms);
    const on = (/** @type {{ state: string }} */ st) => {
      if (st.state === 'running') return;
      clearTimeout(timer);
      sup.off('status', on);
      ok(st);
    };
    sup.on('status', on);
    child.kill('SIGKILL');
  });
}
