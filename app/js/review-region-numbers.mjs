// The numbers of the regions marked on an app in its review (#856): the draft’s, as the answer will give them, the
// next one to mark, and the region each “region N” names, from the threads, the draft and the open comment box.

import { nextRegion, regionAnchor } from '/shared/review-regions.mjs';

/**
 * Gives the draft’s regions the numbers the answer will give them: one an agent’s comment numbered first, while the
 * draft was open, moves to the next number, so the page draws both, each where it is (#856). @param {any} b @param {any} d
 */
export function renumberDraft(b, d) {
  const held = [...(b.threads ?? [])];
  for (const c of d.comments) {
    if (c.region) c.anchor = regionAnchor(c, held);
    held.push(c);
  }
  if (d.composingRegion && typeof d.composing === 'string') d.composing = regionAnchor({ anchor: d.composing, region: d.composingRegion }, held);
}

/** The region of each anchor that has one: the threads’, the drafts’ and the open comment box’s. @param {any} b @param {any} d */
export function regionsOf(b, d) {
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const x of [...(b.threads ?? []), ...d.comments]) if (x.region && typeof x.anchor === 'string') out.set(x.anchor, x.region);
  if (d.composingRegion && typeof d.composing === 'string') out.set(d.composing, d.composingRegion);
  return out;
}

/**
 * The anchor of the next region marked on a review: one past the highest it has, the open box’s too when something is
 * typed in it, since it becomes a draft comment when the new one opens, and a blank one is dropped (startComment).
 * @param {any} b @param {any} d
 */
export function nextAnchor(b, d) {
  const open = d.composingRegion && d.composingText.trim() ? [{ anchor: d.composing }] : [];
  return nextRegion([...(b.threads ?? []), ...d.comments, ...open].map((x) => x.anchor));
}
