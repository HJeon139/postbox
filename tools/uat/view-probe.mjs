// The view probe (#531): each step, before any screenshot scrolls the page (tools/uat/observe.mjs), where each mounted
// transcript’s view is, as app/js/view-state.mjs publishes it (data-view-mode, data-view-anchor, data-view-offset) and
// as the page measures it. tools/uat/room-checks-view.mjs’s view-moved and tools/uat/view-triggers.mjs read it.

import { js } from '../browser.mjs';

/** Two reads a frame apart that differ by more than this, in px, aren’t settled. */
const SETTLE_PX = 0.5;
/** How long to wait for that frame before calling the sample unsettled, in ms. */
const FRAME_WAIT_MS = 200;

/**
 * One sample per transcript (main’s, and the side panel’s when it’s open): its mode, its anchor, the offset it
 * published (expected) and where that item is (actual), from the view’s top as view-state.mjs measures it, and how far
 * the view is from the end (gap). prev: where the last sample’s anchor of this transcript is now, by its key, when that
 * sample was of the same thread and page load (origin) and the item is still mounted; else null. Read twice, a frame
 * apart: settled when both agree within half a pixel.
 * @param {(expr: string) => Promise<any>} ev  the driver’s page.evaluate
 * @param {Record<string, { origin: number, thread: string, anchorId: string }>} last  by where, the last sample’s anchor
 */
export const sampleViews = (ev, last) =>
  ev(`(async (last) => {
    const origin = Math.round(performance.timeOrigin);
    const round = (n) => Math.round(n * 10) / 10;
    const els = [...document.querySelectorAll('.transcript[data-view-mode]')];
    const read = (el) => {
      const where = el.id === 'main' ? 'main' : 'panel';
      const s = where === 'panel' ? el.parentElement : document.scrollingElement;
      const top = where === 'panel' ? s.getBoundingClientRect().top : 0;
      const at = (key) => {
        const n = [...el.children].find((c) => c.dataset && c.dataset.key === key);
        return n ? round(n.getBoundingClientRect().top - top) : null;
      };
      const { thread, viewMode: mode, viewAnchor: anchorId = '', viewOffset = '' } = el.dataset;
      const was = last[where];
      const prevAt = was && was.anchorId && was.origin === origin && was.thread === thread ? at(was.anchorId) : null;
      return {
        where,
        thread,
        mode,
        anchorId,
        expected: viewOffset === '' ? null : Number(viewOffset),
        actual: anchorId ? at(anchorId) : null,
        gap: round(s.scrollHeight - s.scrollTop - s.clientHeight),
        origin,
        prev: prevAt === null ? null : { anchorId: was.anchorId, actual: prevAt },
      };
    };
    const near = (x, y) => (x === null && y === null) || (x !== null && y !== null && Math.abs(x - y) <= ${SETTLE_PX});
    // The gap counts only while following: a reply growing below a reading anchor changes it without moving the view.
    const gapAgrees = (a, b) => a.mode !== 'following' || near(a.gap, b.gap);
    const agree = (a, b) =>
      a.mode === b.mode && a.anchorId === b.anchorId && near(a.actual, b.actual) && gapAgrees(a, b) &&
      near(a.prev && a.prev.actual, b.prev && b.prev.actual);
    const first = els.map(read);
    const framed = await new Promise((done) => {
      requestAnimationFrame(() => done(true));
      setTimeout(() => done(false), ${FRAME_WAIT_MS});
    });
    return els.map((el, i) => {
      const s = read(el);
      return { ...s, settled: framed && agree(first[i], s) };
    });
  })(${js(last)})`);

/**
 * Records a sample of each transcript into facts.probes.views, with the step and when. When the page has none or the
 * probe fails, it counts the miss in facts.probes.viewMisses instead.
 * @param {(expr: string) => Promise<any>} ev  @param {{ probes: { views?: any[], viewMisses?: number } }} facts  @param {number} step
 */
export async function recordViews(ev, facts, step) {
  /** @type {Record<string, { origin: number, thread: string, anchorId: string }>} */
  const last = {};
  // The last settled sample of each transcript: an unsettled one, mid-scroll, may name an anchor the next can't compare.
  for (const s of facts.probes.views ?? []) if (s.settled) last[s.where] = { origin: s.origin, thread: s.thread, anchorId: s.anchorId };
  const samples = await sampleViews(ev, last).catch(() => null);
  if (!Array.isArray(samples) || !samples.length) {
    facts.probes.viewMisses = (facts.probes.viewMisses ?? 0) + 1; // so a probe that never reads isn't taken for a quiet view
    return;
  }
  facts.probes.views ??= [];
  const at = Date.now();
  for (const s of samples) facts.probes.views.push({ step, at, ...s });
}
