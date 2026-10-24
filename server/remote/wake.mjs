// Noticing that this computer woke from sleep (#120, D2): Postbox reconnects to its hosts on its own when the laptop
// wakes, rather than waiting out a backoff timer that slept with it. Node has no wake event, so a timer checks the
// wall clock every WAKE_CHECK_MS. Node’s timers run on a monotonic clock that stands still while the machine sleeps,
// so the check due at the moment of sleep runs just after waking, and the wall clock has moved on by the whole sleep.
// A gap over WAKE_GAP_MS means the machine slept (or the clock was set forward, where an early reconnect is harmless).

/** How often the wall clock is checked. */
export const WAKE_CHECK_MS = 30_000;
/** A gap between checks over this means the machine slept: four checks missed, well past a busy event loop’s delay. */
export const WAKE_GAP_MS = 2 * 60_000;

/**
 * Calls onWake(sleptMs) each time the machine wakes, until the returned stop() is called.
 * @param {(sleptMs: number) => void} onWake
 * @param {{ every?: number, gap?: number, now?: () => number, setInterval?: (fn: () => void, ms: number) => any,
 *           clearInterval?: (t: any) => void }} [o]  the clock and timers, for tests
 * @returns {() => void}
 */
export function watchWake(
  onWake,
  { every = WAKE_CHECK_MS, gap = WAKE_GAP_MS, now = Date.now, setInterval: start = setInterval, clearInterval: stop = clearInterval } = {},
) {
  let last = now();
  const timer = start(() => {
    const at = now();
    const slept = at - last;
    last = at;
    if (slept <= gap) return;
    try {
      onWake(slept);
    } catch (e) {
      console.error(`Postbox noticed this computer woke, but reconnecting to hosts failed: ${e?.message ?? e}`);
    }
  }, every);
  // It mustn’t keep Postbox running on its own.
  timer?.unref?.();
  return () => stop(timer);
}
