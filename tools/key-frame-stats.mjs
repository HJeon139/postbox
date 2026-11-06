// The statistics of PF-1’s key-to-frame tool (#508, tools/bench-key-frame.mjs; designs/508/design.md, “Observability
// and calibration”): each key’s time from its Event Timing entries, percentiles over the keys, and the budget, a large
// room’s p95 within 10% of the 1× room’s. Pure, so tests feed it numbers.

/** PF-1’s budget: a large room’s p95 may be at most this much over the 1× room’s. */
export const PF1_BUDGET = 0.1;

/**
 * Whether an Event Timing time is under one frame: a bound, not a measurement. Chromium reports no entry for a key
 * under the threshold, and keyDurations() counts each such key at the threshold, below every entry, so a percentile
 * over the threshold is an entry’s own and exact, and one at it says only that those keys took at most that. So
 * withinBudget() judges a larger room against the threshold when the 1× room is under one frame: up to 16 ms × 1.1.
 * @param {number | null} value  @param {number} threshold
 */
export const underOneFrame = (value, threshold) => value !== null && value <= threshold;

/**
 * Whether the calibration key, the first one typed, has an Event Timing entry of its own at least minMs long. The
 * page makes that key wait minMs on purpose (tools/key-frame-measure.mjs), so an observer measuring this composer
 * must see it. Without the check, an observer that sees nothing reads as a room whose every key is under one frame.
 * @param {number[]} keys  each key’s keydown timeStamp, in order, the calibration key first
 * @param {{ startTime: number, duration: number }[]} entries  @param {number} minMs
 */
export function calibrated(keys, entries, minMs) {
  if (keys.length === 0) return false;
  const [start, end = Infinity] = keys;
  return entries.some((e) => e.startTime >= start && e.startTime < end && e.duration >= minMs);
}

/**
 * The p-th percentile by nearest rank: the smallest value that at least p% of the values are at or under. Null for
 * no values, so an empty run can’t read as a fast one.
 * @param {number[]} values  @param {number} p  from 0 to 100
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** The count, p50, p95 and max of a list of times. @param {number[]} values */
export function summarize(values) {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : null,
  };
}

/**
 * Whether a large room’s p95 is within budget of the 1× room’s, and their ratio.
 * @param {number} base  the 1× room’s p95  @param {number} other  @param {number} [budget]
 */
export function withinBudget(base, other, budget = PF1_BUDGET) {
  return { ratio: other / base, pass: other <= base * (1 + budget) };
}

/**
 * Each key’s Event Timing time: the longest entry that started at or after its keydown and before the next key’s, so
 * a key’s keydown, keypress and input count as one. Chromium reports no entry under its threshold (16 ms at the
 * least), so a key with none counts at the threshold, an upper bound; below says how many keys did.
 * @param {number[]} keys  each measured key’s keydown timeStamp, in order
 * @param {{ name: string, startTime: number, duration: number }[]} entries
 * @param {number} threshold
 */
export function keyDurations(keys, entries, threshold) {
  const values = keys.map((start, i) => {
    const end = i + 1 < keys.length ? keys[i + 1] : Infinity;
    const mine = entries.filter((e) => e.startTime >= start && e.startTime < end);
    if (mine.length === 0) return null;
    return Math.max(...mine.map((e) => e.duration));
  });
  const below = values.filter((v) => v === null).length;
  return { values: values.map((v) => v ?? threshold), below };
}

/**
 * Why the composer isn’t inside the browser’s window, or null when it is. What lies outside the window is never
 * presented, so a key typed there gets no Event Timing entry until some other change presents a frame (#508, PF-1).
 * @param {{ top: number, bottom: number, left: number, right: number }} rect  the composer’s box, in CSS px
 * @param {{ width: number, height: number }} window  the window’s size, as Chromium reports it
 */
export function outsideWindow(rect, window) {
  if (rect.top < 0) return `The composer starts at ${rect.top} px, above the window.`;
  if (rect.left < 0) return `The composer starts at ${rect.left} px, left of the window.`;
  if (rect.bottom > window.height) return `The composer ends at ${rect.bottom} px, below the window’s ${window.height} px.`;
  if (rect.right > window.width) return `The composer ends at ${rect.right} px, right of the window’s ${window.width} px.`;
  return null;
}
