// The view’s checks (#712a): what the page drew, from the probes the runner records on it each step before any
// screenshot (tools/uat/skip-probe.mjs). They live here, not in server/room-checks.mjs, since only the UAT’s page
// records them: a recorded room has no page, and server code may not import tools/.

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

export const VIEW_CHECKS = [{ id: 'rows-skipped', inputs: ['probes'], issue: 712, run: rowsSkipped }];
