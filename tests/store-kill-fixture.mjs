// Waiting on a store whose process was killed, or whose fsync is held, in a test. A test that awaits only a child’s
// exit, or a gate a store’s write will reach, may have nothing else in the event loop; Node then exits before the
// kernel reports the death (Linux reports a SIGKILLed child late enough for that every time, on CI), and node:test
// cancels every pending test with “Promise resolution is still pending but the event loop has already resolved”,
// naming no cause. So the waits here hold the loop with a ref’d timer, and fail naming what they waited for instead
// of hanging. The module has no side effects, so a plain Node (tests/process/store-commit-child.mjs) can import it as
// a test file does.

/**
 * Awaits a promise that nothing ref’d may be driving (a gate a store’s sync reaches, a child’s output), holding the
 * event loop with a timer meanwhile; rejects naming `what` when it takes longer than `ms`.
 * @template T @param {Promise<T>} promise @param {string} what @param {number} [ms]
 * @returns {Promise<T>}
 */
export function holding(promise, what, ms = 5000) {
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
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

/**
 * Waits for a condition, polling every 25 ms up to `ms`, then fails naming it. Its timer holds the event loop, so
 * it’s a safe wait on a store whose process was killed; for a promise rather than a condition, `holding` does the same.
 * @param {() => boolean} pred @param {string} [what] @param {number} [ms]
 */
export async function until(pred, what = 'the condition', ms = 5000) {
  for (let i = 0; i < ms / 25 && !pred(); i++) await new Promise((ok) => setTimeout(ok, 25));
  if (!pred()) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
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
 * Kills a child process with SIGKILL and resolves with how it exited once the kernel has reported it, holding the
 * event loop meanwhile; rejects, naming the pid, when that takes longer than `ms`.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} [ms]
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
export function killed(child, ms = 5000) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.reject(new Error(`The child (pid ${child.pid}) isn’t running: it exited ${child.exitCode ?? child.signalCode}`));
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => {
      child.off('exit', on);
      fail(new Error(`The child (pid ${child.pid}) wasn’t reported gone within ${ms} ms of SIGKILL`));
    }, ms);
    const on = (/** @type {number | null} */ code, /** @type {NodeJS.Signals | null} */ signal) => {
      clearTimeout(timer);
      ok({ code, signal });
    };
    child.once('exit', on);
    child.kill('SIGKILL');
  });
}
