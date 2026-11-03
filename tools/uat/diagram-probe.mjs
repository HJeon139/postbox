// The diagram probe (#701): each step, before any screenshot scrolls the page (tools/uat/observe.mjs), which diagram
// frames in the conversation have loaded and which are in view. tools/uat/view-triggers.mjs reads it.

/**
 * One sample: the page’s time since it loaded, and each diagram frame in the conversation by its item’s key. A frame
 * has loaded once it has drawn (data-sized) or reported that it couldn’t (data-failed), app/js/md-enhance.mjs.
 * @param {(expr: string) => Promise<any>} ev  the driver’s page.evaluate
 * @returns {Promise<{ sinceLoad: number, frames: { key: string, loaded: boolean, inView: boolean }[] }>}
 */
export const sampleDiagrams = (ev) =>
  ev(`(() => ({
    sinceLoad: Math.round(performance.now()),
    frames: [...document.querySelectorAll('#main.transcript > .item figure.diagram iframe')].map((f) => {
      const r = f.getBoundingClientRect();
      return { key: f.closest('.item').dataset.key, loaded: f.dataset.sized === '1' || f.dataset.failed === '1', inView: r.bottom > 0 && r.top < innerHeight };
    }),
  }))()`);

/**
 * Records a sample into facts.probes.diagrams, when the conversation has any diagram.
 * @param {(expr: string) => Promise<any>} ev  @param {{ probes: { diagrams?: any[] } }} facts  @param {number} step
 */
export async function recordDiagrams(ev, facts, step) {
  const s = await sampleDiagrams(ev).catch(() => null);
  if (!s?.frames.length) return;
  (facts.probes.diagrams ??= []).push({ step, at: Date.now(), ...s });
}
