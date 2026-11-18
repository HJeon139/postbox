// A quota’s times in words (#442; designs/architecture/adapters.md, “Quota: each backend’s usage, in the composer”):
// how long ago a figure was read, and when a window resets. Moved from composer-quota.mjs.

const HOUR = 3_600_000;

/** How long ago, in words: “25 min”, “2 h”, “3 d”. @param {number} ms */
export function age(ms) {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 24 * HOUR) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / (24 * HOUR))} d`;
}

/** “3:10 pm”, or “Tue 3:10 pm” a day or more away. @param {number} at @param {number} now */
export function resetTime(at, now) {
  const opts = /** @type {Intl.DateTimeFormatOptions} */ ({ hour: 'numeric', minute: '2-digit', ...(at - now >= 24 * HOUR ? { weekday: 'short' } : {}) });
  return new Date(at).toLocaleString('en-US', opts).replace(/\s?([AP])M$/, (_m, p) => ` ${p.toLowerCase()}m`);
}
