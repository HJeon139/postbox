// The diagram probe (#701): each step, before any screenshot scrolls the page (tools/uat/observe.mjs), how many diagram
// pages the page has requested, and which diagram frames in the conversation have drawn and which are in view.
// tools/uat/view-triggers.mjs reads it.

/** The browser’s resource timing buffer holds 250 entries unless a page raises it; past that, entries are dropped. */
export const RESOURCE_BUFFER = 250;

/**
 * One sample. requested: the `/sandbox/mermaid` pages the page has asked for since it loaded, from resource timing,
 * which counts a frame’s request whether or not it has drawn: an eager frame out of view is requested but never draws
 * in Chromium. full: the timing buffer may have dropped entries, so requested can’t be trusted. A frame has drawn once
 * it has a size (data-sized) or reported it couldn’t draw (data-failed), app/js/md-enhance.mjs.
 * @param {(expr: string) => Promise<any>} ev  the driver’s page.evaluate
 * @returns {Promise<{ sinceLoad: number, requested: number, full: boolean, frames: { key: string, loaded: boolean, inView: boolean }[] }>}
 */
export const sampleDiagrams = (ev) =>
  ev(`(() => {
    const resources = performance.getEntriesByType('resource');
    return {
      sinceLoad: Math.round(performance.now()),
      requested: resources.filter((r) => new URL(r.name).pathname === '/sandbox/mermaid').length,
      full: resources.length >= ${RESOURCE_BUFFER},
      frames: [...document.querySelectorAll('#main.transcript > .item figure.diagram iframe')].map((f) => {
        const r = f.getBoundingClientRect();
        return { key: f.closest('.item').dataset.key, loaded: f.dataset.sized === '1' || f.dataset.failed === '1', inView: r.bottom > 0 && r.top < innerHeight };
      }),
    };
  })()`);

/**
 * Records a sample into facts.probes.diagrams, when the conversation has any diagram.
 * @param {(expr: string) => Promise<any>} ev  @param {{ probes: { diagrams?: any[] } }} facts  @param {number} step
 */
export async function recordDiagrams(ev, facts, step) {
  const s = await sampleDiagrams(ev).catch(() => null);
  if (!s?.frames.length) return;
  facts.probes.diagrams ??= [];
  facts.probes.diagrams.push({ step, at: Date.now(), ...s });
}
