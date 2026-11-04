// The statistics of PF-1’s key-to-frame tool (#508, tools/bench-key-frame.mjs; designs/508/design.md, “Observability
// and calibration”): each key’s time from its Event Timing entries, percentiles over the keys, and the budget, a large
// room’s p95 within 10% of the 1× room’s. Pure, so tests feed it numbers.

/** PF-1’s budget: a large room’s p95 may be at most this much over the 1× room’s. */
export const PF1_BUDGET = 0.1;

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
