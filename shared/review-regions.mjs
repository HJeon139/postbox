// The regions a person marks on an app in its review (#856): a point or a box anywhere on the app, the anchor that
// names it, “region 1”, and how it reads as text. A comment or a thread on one carries it (review-comments.mjs). Pure,
// so the browser, the server and the tests share it.

import { described, int, obj } from './schema.mjs';

/** A fraction of the app’s width or height, from 0 to 1. @type {import('./schema.mjs').Rule} */
const fraction = described(
  (v, path, errs) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) errs.push(`${path} must be a number from 0 to 1, a fraction of the app’s size.`);
  },
  { type: 'number', minimum: 0, maximum: 1 },
);
/**
 * A region of an app the person marked in its review (#856): its left edge x, top y, width w and height h as fractions
 * of the app’s width and height, so it holds at any window size, and the app version it was made on, since another
 * version may draw something else there. w and h of 0 is a point.
 */
export const REGION = obj({ x: fraction, y: fraction, w: fraction, h: fraction, version: int({ min: 1, max: 1_000_000 }) }, ['x', 'y', 'w', 'h', 'version']);
/** The anchor a region comment is grouped and threaded by, as a named part is: “region 1”, numbered in its review. */
export const REGION_ANCHOR = /^region [1-9]\d*$/;

/**
 * Why a comment’s or thread’s region isn’t one, or null: it stays inside the app, and is named by its anchor, “region
 * 1”. The fields themselves are checked by REGION.
 * @param {Record<string, any>} c
 */
export function regionError(c) {
  const r = c.region;
  if (r === undefined || r === null || typeof r !== 'object') return null;
  // Within a rounding error: 0.7 + 0.3 is 1.0000000000000002 in floating point.
  if (r.x + r.w > 1 + 1e-9 || r.y + r.h > 1 + 1e-9) return 'a region stays inside the app: x + w and y + h are at most 1.';
  if (typeof c.anchor !== 'string' || !REGION_ANCHOR.test(c.anchor)) return 'a comment on a region names it as anchor, such as “region 1”.';
  return null;
}

/**
 * Why a new comment names a region it doesn’t carry, or null: “region 1”, “region 2” and so on are the regions the
 * person marks, so a part can’t take that name (#856). Checked on comments as they come in, not on a review’s stored
 * threads: a part an app named that way before #856 keeps its thread. @param {Record<string, any>} c
 */
export function regionNameError(c) {
  if (c.region != null || typeof c.anchor !== 'string' || !REGION_ANCHOR.test(c.anchor)) return null;
  return `“${c.anchor}” names a marked region, so it needs its region: { x, y, w, h, version }.`;
}

/** Whether two regions are the same place on the same version. @param {any} a @param {any} b */
export const sameRegion = (a, b) => ['x', 'y', 'w', 'h', 'version'].every((k) => a?.[k] === b?.[k]);

/**
 * The anchor a comment on a region takes beside what the review already holds: its own, unless another thread holds
 * that “region N” for another place, or for a part. An agent’s comment can arrive while the person’s draft, numbered
 * from what was on screen, is still open (#856), so the page draws both and the answer keeps both, each under its own
 * number: the place’s number if a thread already holds it, else the next past every “region N” held.
 * @param {Record<string, any>} c  the comment @param {any[]} held  the threads, and comments placed before this one
 */
export function regionAnchor(c, held) {
  if (!c.region || typeof c.anchor !== 'string') return c.anchor;
  const named = held.filter((t) => typeof t.anchor === 'string' && REGION_ANCHOR.test(t.anchor));
  if (!named.some((t) => t.anchor === c.anchor && !sameRegion(t.region, c.region))) return c.anchor;
  const same = named.find((t) => t.region && sameRegion(t.region, c.region));
  if (same) return same.anchor;
  return `region ${Math.max(0, ...named.map((t) => Number(t.anchor.slice('region '.length)))) + 1}`;
}

/**
 * Why a review’s threads name one region twice, as sentences: each “region N” is one place, so two threads on it with
 * different regions would draw one and list the other in the wrong place (#856). @param {any[]} threads
 */
export function regionClashes(threads) {
  const seen = new Map();
  const errs = [];
  for (const [i, t] of threads.entries()) {
    if (!t?.region || typeof t.anchor !== 'string') continue;
    const first = seen.get(t.anchor);
    if (first && !sameRegion(first.region, t.region))
      errs.push(`threads[${i}]: “${t.anchor}” is already threads[${first.i}]’s region; give this one the next number.`);
    else if (!first) seen.set(t.anchor, { i, region: t.region });
  }
  return errs;
}

/** A percentage as people read it: 12%, or 12.5% where the tenth matters. @param {number} f  a fraction */
const pct = (f) => `${Math.round(f * 1000) / 10}%`;
/**
 * A region as text (#856): “x 12%, y 30%, 20% × 15%, on v3”, or “a point at x 12%, y 30%, on v3”. Every drawn region
 * is also said this way, to the agent and on the page. @param {{ x: number, y: number, w: number, h: number, version: number }} r
 */
export function regionText(r) {
  const at = `x ${pct(r.x)}, y ${pct(r.y)}`;
  return r.w === 0 && r.h === 0 ? `a point at ${at}, on v${r.version}` : `${at}, ${pct(r.w)} × ${pct(r.h)}, on v${r.version}`;
}
