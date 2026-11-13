// Stopping a CLI Postbox asked something and no longer waits on: a `--version` probe or a model listing that ran
// out of time, or a listing that has answered. SIGTERM first, then SIGKILL if it hasn’t closed after a short grace,
// as Stop does for a turn (process-group.mjs), so a CLI that traps SIGTERM isn’t left running.

/** How long a probe has to close after SIGTERM before it gets SIGKILL. */
export const PROBE_GRACE_MS = 2000;

/**
 * Stops the child: SIGTERM now, SIGKILL after graceMs unless it closed first. A child that already ended is left be.
 * @param {{ kill: (signal?: NodeJS.Signals) => unknown, once: (event: 'close', fn: () => void) => unknown,
 *   exitCode?: number | null, signalCode?: string | null }} child
 * @param {number} [graceMs]
 */
export function stopProbe(child, graceMs = PROBE_GRACE_MS) {
  if (child.exitCode != null || child.signalCode != null) return;
  let closed = false;
  child.once('close', () => {
    closed = true;
  });
  try {
    child.kill('SIGTERM');
  } catch {
    return; // Already gone: nothing to stop.
  }
  const timer = setTimeout(() => {
    if (closed) return;
    try {
      child.kill('SIGKILL');
    } catch {} // It ended between the check and the kill.
  }, graceMs);
  timer.unref?.();
}
