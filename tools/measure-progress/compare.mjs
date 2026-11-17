// Comparing a branch with main (tools/measure-progress.mjs --against): runs of the two alternate in ABBA order, so a
// machine growing busier or calmer weighs on both alike, and each pair’s times are taken as a ratio, this branch over
// main. A real cost of 11 to 16% passed a rule that held one band’s median against the other’s most, on a busy machine
// (#1461’s review). Bytes are compared as they are: they repeat to the digits of a time.

/** A number’s key that is a time, compared by ratio; the rest are counts and bytes. @param {string} k */
export const isTime = (k) => k.endsWith('Ms') || k === 'usPerDelta';
/** The time a delta is the mappers’ time (pushMs) over a count that doesn’t change: judged once, as pushMs. */
const JUDGED_AS_ANOTHER = new Set(['usPerDelta']);

/**
 * How much more time, as a share, this branch may take before it’s worse than main. Run against itself on a busy
 * machine (a load average of 5 to 17), the tool’s own spread came to 9.9% at most, by the smaller of the two ratios.
 */
export const TIME_TOLERANCE = 0.1;
/**
 * A time under this, in main’s least run, is reported and not judged. Run against itself, the tool’s times of a few
 * milliseconds, such as the mappers’ 2.5 to 4 ms in a crowd, came out 11 to 16% apart on noise alone (#1461’s review).
 */
const TIME_FLOOR = 20;
/** How much more a count of bytes may be, as a share or in bytes, whichever is more: the digits of times. */
const BYTE_SHARE = 0.001;
const BYTE_FLOOR = 64;

/** The order of the i-th pair: main first, then this branch, then the other way, so ABBA ABBA. @param {number} i */
export const mainFirst = (i) => i % 2 === 0;

/** The median of numbers. @param {number[]} xs */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Each row’s and number’s verdict, from runs of main and of this branch made in pairs: `main[i]` and `branch[i]` are
 * the i-th pair’s rows. A time is worse when the median of the pairs’ ratios and the ratio of the least runs are both
 * above 1 + TIME_TOLERANCE: a real cost moves both, and noise seldom does. Bytes and counts are worse when this
 * branch’s least is above main’s most by more than their tolerance.
 * @param {any[][]} main @param {any[][]} branch
 */
export function compare(main, branch) {
  /** @type {{ row: string, key: string, main: number, branch: number, ratio?: number, leastRatio?: number, worse: boolean }[]} */
  const out = [];
  for (const [r, first] of main[0].entries())
    for (const [key, v] of Object.entries(first)) {
      if (typeof v !== 'number') continue;
      const a = main.map((rows) => rows[r]?.[key]).filter((x) => typeof x === 'number');
      const b = branch.map((rows) => rows[r]?.[key]).filter((x) => typeof x === 'number');
      if (!a.length || a.length !== b.length) continue;
      if (isTime(key)) {
        const ratio = median(a.map((x, i) => b[i] / x));
        const leastRatio = Math.min(...b) / Math.min(...a);
        const judged = !JUDGED_AS_ANOTHER.has(key) && Math.min(...a) >= TIME_FLOOR;
        const worse = judged && ratio > 1 + TIME_TOLERANCE && leastRatio > 1 + TIME_TOLERANCE;
        out.push({ row: first.row, key, main: median(a), branch: median(b), ratio, leastRatio, worse });
      } else {
        const most = Math.max(...a);
        const worse = Math.min(...b) - most > Math.max(BYTE_FLOOR, most * BYTE_SHARE);
        out.push({ row: first.row, key, main: median(a), branch: median(b), worse });
      }
    }
  return out;
}

/**
 * The numbers worse in both of two rounds of pairs: a number worse in the first is worse only if the second, run
 * after it, agrees, so one unlucky round doesn’t fail a step. @param {ReturnType<typeof compare>} first
 * @param {ReturnType<typeof compare>} second
 */
export function worseTwice(first, second) {
  const again = new Set(second.filter((c) => c.worse).map((c) => `${c.row}\0${c.key}`));
  return first.filter((c) => c.worse && again.has(`${c.row}\0${c.key}`));
}
