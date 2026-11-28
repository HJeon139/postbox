// The regions a person marks on an app in its review (#856): a point or a box anywhere on the app, the anchor that
// names it, “region 1”, and how it reads as text. A comment or a thread on one carries it (review-comments.mjs). Pure,
// so the browser, the server and the tests share it.

import { REGION_UNDER as CAP, REGION_PX } from './limits.mjs';
import { int, list, obj, str } from './schema.mjs';
import { cleanSaid } from './text-parts.mjs';

/**
 * What the app had under a region when the person marked it (#856), as the kit in its frame told the page: the named
 * parts the region overlaps, and the innermost element at its center. The app’s own data, cut to REGION_UNDER.
 */
const UNDER = obj({
  parts: list(str({ min: 1, max: CAP.part }), { max: CAP.parts }),
  element: obj({ tag: str({ min: 1, max: CAP.tag }), id: str({ max: CAP.id }), class: str({ max: CAP.class }), text: str({ max: CAP.text }) }, ['tag']),
});

/**
 * A region of an app the person marked in its review (#856), in CSS px of the app’s page: its left edge x, top y,
 * width w and height h, and the width and height of the frame it was marked in. A frame of another width may lay the
 * app out another way, so a region is drawn only in a frame as wide as that; content above it doesn’t move when the
 * app grows below it, so it stays over what was marked. With the app version it was made on, since another version may
 * draw something else there. w and h of 0 is a point. under, when the app answered in time, is what it had there.
 */
export const REGION = obj(
  {
    x: int({ min: 0, max: REGION_PX.width }),
    y: int({ min: 0, max: REGION_PX.height }),
    w: int({ min: 0, max: REGION_PX.width }),
    h: int({ min: 0, max: REGION_PX.height }),
    width: int({ min: 1, max: REGION_PX.width }),
    height: int({ min: 1, max: REGION_PX.height }),
    version: int({ min: 1, max: 1_000_000 }),
    under: UNDER,
  },
  ['x', 'y', 'w', 'h', 'width', 'height', 'version'],
);
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
  if (r.x + r.w > r.width || r.y + r.h > r.height) return 'a region stays inside the app: x + w is at most width, and y + h at most height.';
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
  return `“${c.anchor}” names a marked region, so it needs its region: { x, y, w, h, width, height, version }.`;
}

/** Whether two regions are the same place, marked in the same frame on the same version. @param {any} a @param {any} b */
export const sameRegion = (a, b) => ['x', 'y', 'w', 'h', 'width', 'height', 'version'].every((k) => a?.[k] === b?.[k]);

/** The next “region N” anchor past every “region N” in `anchors` (#856). @param {unknown[]} anchors */
export function nextRegion(anchors) {
  const nums = anchors.filter((a) => typeof a === 'string' && REGION_ANCHOR.test(a)).map((a) => Number(/** @type {string} */ (a).slice('region '.length)));
  return `region ${Math.max(0, ...nums) + 1}`;
}

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
  return nextRegion(named.map((t) => t.anchor));
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

/**
 * A region as text (#856): “x 120, y 300, 240 × 150 px, on v3, in a 1180 × 640 px frame”, or “a point at x 120, y
 * 300, on v3, in a 1180 × 640 px frame”. The frame’s size says which layout the person saw. Every drawn region is also
 * said this way, to the agent and on the page.
 * @param {{ x: number, y: number, w: number, h: number, width: number, height: number, version: number }} r
 */
export function regionText(r) {
  const at = `x ${r.x}, y ${r.y}`;
  const where = r.w === 0 && r.h === 0 ? `a point at ${at}` : `${at}, ${r.w} × ${r.h} px`;
  return `${where}, on v${r.version}, in a ${r.width} × ${r.height} px frame`;
}

/** One of the app’s strings, cleaned of bidi/invisible characters, on one line and cut to n characters, or '' for anything else. @param {unknown} v @param {number} n */
const oneLine = (v, n) => (typeof v === 'string' ? cleanSaid(v, n) : '');

/**
 * What the kit said is under a region, as the region keeps it: strings on one line and cut to REGION_UNDER, empty
 * ones dropped, and null when nothing is left or it isn’t one. What an app sends is its own, so it’s checked here.
 * @param {any} raw  the kit’s answer: { parts, element: { tag, id, class, text } }
 */
export function underOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const parts = Array.isArray(raw.parts)
    ? raw.parts
        .map((p) => oneLine(p, CAP.part))
        .filter(Boolean)
        .slice(0, CAP.parts)
    : [];
  const e = raw.element && typeof raw.element === 'object' ? raw.element : {};
  const fields = { tag: oneLine(e.tag, CAP.tag).toLowerCase(), id: oneLine(e.id, CAP.id), class: oneLine(e.class, CAP.class), text: oneLine(e.text, CAP.text) };
  const element = fields.tag ? Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) : null;
  const under = { ...(parts.length ? { parts } : {}), ...(element ? { element } : {}) };
  /** @type {string[]} */
  const errs = [];
  UNDER(under, 'under', errs);
  return Object.keys(under).length && !errs.length ? under : null;
}

/**
 * What the app had under a region, for underLine: “parts: legend; at center, <p id="total" class="big"> text: Twelve books.”,
 * or '' when the app didn’t say. Kept out of the person’s comment text so it’s never read as the person’s words (#856).
 * @param {any} u  a region’s under
 */
export function underText(u) {
  if (!u) return '';
  const bits = [];
  if (u.parts?.length) bits.push(`parts: ${u.parts.join(', ')}`);
  const e = u.element;
  if (e) {
    const attrs = `${e.id ? ` id="${e.id}"` : ''}${e.class ? ` class="${e.class}"` : ''}`;
    bits.push(`at center, <${e.tag}${attrs}>${e.text ? ` text: ${e.text}` : ''}`);
  }
  return bits.join('; ');
}

/**
 * A separate line carrying the app’s own content under a mark, clearly labeled as not the person’s words (#856), or ''.
 * @param {Record<string, any>} c
 */
export function underLine(c) {
  const text = underText(c?.region?.under);
  return text ? `\n  App content under this mark, not the person’s words: ${text}` : '';
}
