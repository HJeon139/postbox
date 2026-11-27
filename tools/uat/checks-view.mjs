// The view’s checks (#712a): what the page drew, from the probes the runner records on it each step before any
// screenshot (tools/uat/skip-probe.mjs), and on each whole-window screenshot (tools/uat/layout-probe.mjs, #681).

/** A room longer than this must have most of its items skipped, as the big-room scenario’s does (#712). */
export const LONG_ROOM = 1000;

/**
 * A settled sample of a room of more than LONG_ROOM items with fewer than half of them skipped: the rule that lets the
 * browser skip items off screen isn’t working, so every item is laid out and painted. With it on, Chromium skipped
 * 1,176 of 1,200 (tests/fixtures/uat/skip-probe-samples.json). A browser that can’t say which items it skips can’t
 * tell, so its samples are listed as unverified; a run from before the probe has no samples, and stays silent.
 * @param {{ probes?: { skipped?: any[] } }} f
 */
function rowsSkipped(f) {
  const long = (f.probes?.skipped ?? []).filter((s) => s.settled && s.items > LONG_ROOM);
  const bad = long.find((s) => s.supported && s.skipped * 2 < s.items);
  if (bad) {
    return [
      {
        key: `rows-skipped:${bad.thread}`,
        title: 'The browser lays out every item of a long room',
        evidence: `At step ${bad.step}, ${bad.skipped} of the conversation’s ${bad.items} items were skipped, fewer than half; the transcript ${bad.gated ? 'had' : 'didn’t have'} the cv-skip class.`,
      },
    ];
  }
  const unknown = long.find((s) => !s.supported);
  if (!unknown) return [];
  return [
    {
      key: 'rows-skipped:unverified',
      issue: null,
      title: 'rows-skipped isn’t checkable in this browser',
      evidence: `At step ${unknown.step} the conversation had ${unknown.items} items, but the browser doesn’t read checkVisibility’s contentVisibilityAuto option, so which it skipped can’t be told.`,
      verdict: 'measurement',
      note: 'Not a defect: rows-skipped couldn’t tell which items this browser skipped, so this run doesn’t verify it.',
      unverified: { check: 'rows-skipped', thread: unknown.thread },
    },
  ];
}

export const TEXT_LAYOUT = 'text-layout';

/**
 * #681: text drawn over text or run into a control, cut off by its box, or broken mid-word, on a whole-window
 * screenshot, one finding for each problem however many screenshots show it. Each fails the run (checks-postbox.mjs,
 * failsRun). A screenshot the check couldn’t measure, or one of its checks that threw (check-error), is listed as
 * unverified instead, and fails nothing.
 * @param {{ probes?: { layout?: any[] } }} f
 */
function textLayout(f) {
  const out = new Map();
  for (const s of f.probes?.layout ?? []) {
    const unmeasured = s.error ?? s.problems.find((p) => p.code === 'check-error')?.message;
    if (unmeasured)
      out.set(`unverified:${s.step}`, {
        key: `${TEXT_LAYOUT}:unverified:${s.step}`,
        issue: null,
        title: 'text-layout couldn’t check a screenshot',
        evidence: `At step ${s.step}: ${unmeasured}`,
        verdict: 'measurement',
        note: 'Not a defect: the layout check couldn’t measure this screenshot, so the run doesn’t verify it.',
        unverified: { check: TEXT_LAYOUT, step: s.step },
      });
    for (const p of s.error ? [] : s.problems.filter((x) => x.code !== 'check-error')) {
      // The same problem on each screenshot is one finding, the first: its key leaves out the width the message starts
      // with, and the sizes it measured, which change with the width.
      const key = `${TEXT_LAYOUT}:${p.code}:${p.message.replace(/^At \d+ px, /, '').replace(/\d+(?: × \d+)? px/g, '… px')}`;
      if (!out.has(key))
        out.set(key, {
          key,
          title: 'Text on a Postbox screen is drawn over other text or a control, cut off, or broken mid-word',
          evidence: `At step ${s.step}, in a window ${s.width} px wide: ${p.message}`,
        });
    }
  }
  return [...out.values()];
}

export const VIEW_CHECKS = [
  { id: 'rows-skipped', inputs: ['probes'], issue: 712, run: rowsSkipped },
  { id: TEXT_LAYOUT, inputs: ['probes'], issue: 681, run: textLayout },
];
