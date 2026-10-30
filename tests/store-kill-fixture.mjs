// Killing a store’s Redis child in a test, and waiting on what follows (tests/AGENTS.md, “The store’s Redis”). Once the
// child runs, nothing of it keeps the event loop alive: the supervisor unrefs it, its pipes and its restart timer, and
// an idle connection is unref’d too. A test that kills it and awaits only its exit, the supervisor’s next status, or a
// gate the restarted child’s catch-up will reach, may have nothing else in the loop; Node then exits before the kernel
// reports the death (or between the catch-up’s backoff timer and the unref’d restart), and node:test cancels every
// pending test with “Promise resolution is still pending but the event loop has already resolved”, naming no cause.
// Linux reports a SIGKILLed child late enough for that every time (CI). So the waits here hold the loop, and fail
// naming the supervisor’s status instead of hanging when the child doesn’t go. The module has no side effects, so a
// plain Node (tests/process/store-kill-child.mjs, tests/process/store-recovery-child.mjs) can import it as a test file
// does through tests/store-fixture.mjs.

/**
 * Awaits a promise that nothing ref’d may be driving (a gate the store’s catch-up reaches, a status, Retry), holding
 * the event loop with a timer meanwhile; rejects naming `what` and the store’s Redis status when it takes longer than
 * `ms`. Use it for every wait on a store whose child was killed or whose connection dropped, where `until` doesn’t fit.
 * @template T @param {Promise<T>} promise @param {string} what @param {any} [s] a Store @param {number} [ms]
 * @returns {Promise<T>}
 */
export function holding(promise, what, s, ms = 5000) {
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => {
      const status = s ? `; the store’s Redis: ${JSON.stringify(s.redis?.sup?.status ?? 'none')}` : '';
      fail(new Error(`timed out after ${ms} ms waiting for ${what}${status}`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        ok(v);
      },
      (e) => {
        clearTimeout(timer);
        fail(e);
      },
    );
  });
}

/** A gate: `hit` resolves once something waits at it, and `go()` lets it on. Await `hit` through `holding`. */
export function gate() {
  let go = () => {};
  let enter = () => {};
  const opened = new Promise((ok) => (go = ok));
  const hit = new Promise((ok) => (enter = ok));
  const wait = () => {
    enter();
    return opened;
  };
  return { hit, go: () => go(), wait };
}

/**
 * Makes the store’s next EVAL run in Redis, then kills the child before Postbox reads the reply; with `g`, the EVAL
 * waits at that gate first. @param {any} s a Store @param {ReturnType<typeof gate>} [g]
 */
export function loseReply(s, g) {
  const sup = s.redis.sup;
  const client = s.client;
  const call = client.call.bind(client);
  client.call = async (/** @type {any[]} */ ...a) => {
    if (a[0] !== 'EVAL') return call(...a);
    await g?.wait();
    await call(...a);
    sup.child.kill('SIGKILL');
    throw Object.assign(new Error('The connection to the store’s Redis closed before it answered.'), { code: 'ESTOREDOWN' });
  };
}

/**
 * Holds the first `GET seq` on the next connection the store’s child gives (catch-up’s first read) at a gate. The
 * child it comes back on is unref’d, so await `hit` through `holding`. @param {any} s a Store
 */
export function holdCatchUp(s) {
  const g = gate();
  const sup = s.redis.sup;
  const factory = sup.client.bind(sup);
  let once = true;
  sup.client = async () => {
    const c = await factory();
    const real = c.call.bind(c);
    c.call = async (/** @type {any[]} */ ...a) => {
      const r = await real(...a);
      if (once && a[0] === 'GET' && a[1] === 'seq') {
        once = false;
        await g.wait();
      }
      return r;
    };
    return c;
  };
  return g;
}

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
