// The layout probe (#681): each whole-window screenshot the runner takes (tools/uat/driver-shots.mjs, shotScreen) is
// checked for text drawn over text or run into a control, text cut off by its box, and words broken mid-word, by the
// check the browser specs run too (tools/text-layout.mjs). tools/uat/checks-view.mjs reads what it records, and any
// problem fails the run (tools/uat/checks-postbox.mjs, failsRun).

import { TEXT_LAYOUT } from '../text-layout.mjs';

/**
 * One sample of the window: its width and the problems the check found, as { code, message }, or the error that
 * stopped it measuring.
 * @param {(expr: string) => Promise<any>} ev  the driver’s page.evaluate, or Playwright’s
 * @returns {Promise<{ width: number, problems: { code: string, message: string }[] } | { error: string }>}
 */
export async function sampleLayout(ev) {
  try {
    const problems = await ev(TEXT_LAYOUT);
    return { width: await ev('innerWidth'), problems };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Records each sample into probes.layout, stamped with the step it’s in and when.
 * @param {{ layout?: any[] }} probes  @param {() => number} stepNow
 */
export const recordLayout = (probes, stepNow) => (/** @type {any} */ sample) => {
  (probes.layout ??= []).push({ step: stepNow(), at: Date.now(), ...sample });
};
