// Ending a child process, and waiting until it has gone (#120).

/**
 * Asks a child to end, and resolves once it has, so its ports are free (a UAT run’s stop checks them,
 * tools/uat/stop.mjs). One still there after ms is killed. Its stderr is let go then too, since a helper it started
 * (Chrome’s crash handler, say) can hold that pipe open after it, and keep this process from exiting.
 * @param {import('node:child_process').ChildProcess} child @param {number} [ms]
 */
export async function untilGone(child, ms = 10_000) {
  if (child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((ok) => child.once('exit', ok));
    child.kill();
    if (!(await within(gone, ms))) {
      child.kill('SIGKILL');
      await within(gone, ms);
    }
  }
  child.stderr?.destroy();
}

/** Whether p settles within ms. Its timer is cleared either way, so it never holds the process open. @param {Promise<unknown>} p @param {number} ms */
function within(p, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const late = new Promise((ok) => {
    timer = setTimeout(ok, ms, false);
  });
  return Promise.race([p.then(() => true), late]).finally(() => clearTimeout(timer));
}
