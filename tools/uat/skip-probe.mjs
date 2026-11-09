// The skipped-items probe (#712a): each step, before any screenshot scrolls an item into view and so draws it
// (tools/uat/observe.mjs), how many of the conversation’s items the browser is skipping (`content-visibility: auto`,
// app/js/view-skip.mjs). tools/uat/checks-view.mjs reads it.

/**
 * One sample of #main’s transcript, or null when the page shows none. An item is skipped when its content is: the
 * item itself is the box `content-visibility` applies to, so its own checkVisibility() is true even while skipped, and
 * its first child is asked instead. supported: whether the browser reads checkVisibility’s `contentVisibilityAuto`
 * option (Chromium 121 on); one that ignores it calls every item visible, so then skipped is null, not 0. gated: the
 * transcript has the class that lets the browser skip its items. settled: two frames came first, so the browser has
 * decided which items are near the view; a page that draws no frames within a second (in the background) isn’t.
 * origin: when this page load began. O(items): about 1 ms at 1,000 items and 11 ms at 10,000, in Chromium.
 * @param {(expr: string) => Promise<any>} ev  the driver’s page.evaluate
 * @returns {Promise<{ origin: number, thread: string|null, items: number, skipped: number|null, supported: boolean, gated: boolean, settled: boolean } | null>}
 */
export const sampleSkipped = (ev) =>
  ev(`(async () => {
    const el = document.querySelector('#main.transcript');
    if (!el) return null;
    const settled = await Promise.race([
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))),
      new Promise((r) => setTimeout(() => r(false), 1000)),
    ]);
    const items = [...el.children].filter((n) => n.classList.contains('item'));
    let supported = false;
    if (typeof el.checkVisibility === 'function') {
      el.checkVisibility({
        get contentVisibilityAuto() {
          supported = true;
          return true;
        },
      });
    }
    const skipped = supported
      ? items.filter((n) => n.firstElementChild && !n.firstElementChild.checkVisibility({ contentVisibilityAuto: true })).length
      : null;
    return {
      origin: Math.round(performance.timeOrigin),
      thread: el.dataset.thread ?? null,
      items: items.length,
      skipped,
      supported,
      gated: el.classList.contains('cv-skip'),
      settled,
    };
  })()`);

/**
 * Records a sample into facts.probes.skipped, when the page shows a conversation.
 * @param {(expr: string) => Promise<any>} ev  @param {{ probes: { skipped?: any[] } }} facts  @param {number} step
 */
export async function recordSkipped(ev, facts, step) {
  const s = await sampleSkipped(ev).catch(() => null);
  if (!s) return;
  facts.probes.skipped ??= [];
  facts.probes.skipped.push({ step, at: Date.now(), ...s });
}
