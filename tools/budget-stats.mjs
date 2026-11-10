// The budget spec’s verdicts (#1166, tests/browser/budget.spec.mjs; #1155’s target): every interaction paints within
// 100 ms, p95, and the page holds at most about 5,000 elements. Each verdict is “pass”, “fail” or “not measured”: a
// measure that saw nothing, or couldn’t tell a fast key from an unseen one, never reads as a pass. Pure, so tests feed
// it numbers.

import { keyDurations, percentile, summarize } from './key-frame-stats.mjs';

/** #1155’s target: from input to the next paint, p95. */
export const BUDGET_MS = 100;
/** #1155’s page-wide element budget. */
export const ELEMENT_BUDGET = 5000;
/** An idle page’s median frame gap, in ms: about 60 frames a second, give or take a loaded machine. */
const IDLE_GAP = { min: 10, max: 25 };

/** @typedef {'pass' | 'fail' | 'not measured'} Verdict */

/**
 * Each pressed key’s time from its Event Timing entries (keyDurations: the longest entry from its keydown to the next
 * key’s). A key with no entry was under the threshold only if a frame followed it; with no frame either, nothing was
 * drawn for it, and it’s unmeasured.
 * @param {{ at: number, framed: boolean }[]} keys  each key’s keydown timeStamp, and whether a frame ran after it
 * @param {{ name: string, startTime: number, duration: number }[]} entries
 * @param {number} threshold  the observer’s durationThreshold
 */
export function keyTimes(keys, entries, threshold) {
  const { values } = keyDurations(
    keys.map((k) => k.at),
    entries,
    threshold,
  );
  const unseen = keys.filter((k, i) => !k.framed && !hasEntry(k.at, keys[i + 1]?.at, entries));
  return { values, unmeasured: unseen.length };
}

/** @param {number} start  @param {number | undefined} end  @param {{ startTime: number }[]} entries */
const hasEntry = (start, end = Infinity, entries) => entries.some((e) => e.startTime >= start && e.startTime < end);

/**
 * How many keys were timed at more than twice the longest frame gap around them: their frames weren’t presented, so
 * Event Timing ran each to whatever was presented next. Chromium’s full headless mode did that to the composer, 0.7
 * to 2 s a key while frames ran every 20 ms. A long task holds both back, so a slow key under one is still a time.
 * @param {number[]} values  each key’s time  @param {number | null} longestGap  @param {number} threshold
 */
export function unpresented(values, longestGap, threshold) {
  const bound = 2 * Math.max(longestGap ?? 0, threshold);
  return values.filter((v) => v > bound).length;
}

/**
 * Whether the entries are in key order up to the planted key that ends a run: none that started before it arrives
 * after its own. The run relies on that order to know every measured key’s entry is in once the planted key’s is.
 * @param {{ startTime: number }[]} entries  in the order they arrived  @param {number} plantedAt  its keydown timeStamp
 */
export function entriesInOrder(entries, plantedAt) {
  const at = entries.findIndex((e) => e.startTime >= plantedAt);
  if (at < 0) return false;
  return entries.slice(at).every((e) => e.startTime >= plantedAt);
}

/**
 * A timed measure’s verdict, with its sample count beside its p95: with 5 samples the p95 is the slowest one.
 * @param {number[]} values  in ms  @param {{ unmeasured?: number, budget?: number }} [o]
 * @returns {ReturnType<typeof summarize> & { verdict: Verdict }}
 */
export function timedVerdict(values, { unmeasured = 0, budget = BUDGET_MS } = {}) {
  const stats = summarize(values);
  return { ...stats, verdict: verdictOf(stats.p95, budget, unmeasured > 0) };
}

/**
 * The longest gap between frames while a measure ran: an upper bound on the longest task in it. The loop’s gaps must
 * cover the measure, to within one budget: a loop that stopped, as on a hidden page, leaves the rest of the measure
 * unwatched, and the measure is unmeasured. A long task still counts, as one long gap.
 * @param {number[]} gaps  in ms  @param {number} lengthMs  how long the measure ran
 * @param {number} [budget]
 */
export function gapVerdict(gaps, lengthMs, budget = BUDGET_MS) {
  const longest = gaps.length ? Math.max(...gaps) : null;
  const watched = gaps.reduce((sum, gap) => sum + gap, 0);
  const unwatched = gaps.length === 0 || watched < lengthMs - budget;
  return { frames: gaps.length, longest, watchedMs: watched, verdict: verdictOf(longest, budget, unwatched) };
}

/**
 * Whether the frame probe measures this browser: an idle page’s median gap is about one frame, and a busy loop
 * planted for busyMs shows as a gap at least that long.
 * @param {number[]} idleGaps  @param {number} busyGap  the longest gap around the planted loop  @param {number} busyMs
 */
export function gapCalibrated(idleGaps, busyGap, busyMs) {
  const idle = percentile(idleGaps, 50);
  if (idle === null) return false;
  return idle >= IDLE_GAP.min && idle <= IDLE_GAP.max && busyGap >= busyMs;
}

/** The page’s element count against the budget; null when it was never read. @param {number | null} count */
export function elementsVerdict(count, budget = ELEMENT_BUDGET) {
  return { count, verdict: verdictOf(count, budget, count === null) };
}

/** @param {number | null} value  @param {number} budget  @param {boolean} unmeasured  @returns {Verdict} */
function verdictOf(value, budget, unmeasured) {
  if (unmeasured || value === null) return 'not measured';
  return value <= budget ? 'pass' : 'fail';
}
