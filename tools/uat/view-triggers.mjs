// The long room’s view triggers (#508 lane, tests/uat/e2e/scenarios/bigroom.md): what the page draws far from the view.
// tools/uat/triggers.mjs adds them to TRIGGERS. Each reads the probes the runner records from the page
// (tools/uat/diagram-probe.mjs), not the state, since what’s drawn isn’t in it.

/**
 * The page had asked for fewer diagram pages than it had diagram frames, with one out of view and not drawn, and a later
 * sample of the same page load shows more pages asked for and that frame drawn: the page deferred the frame until it
 * neared the view, then loaded it (#695, #701). An eager frame is requested as it’s mounted, so without #701 the page
 * has asked for every frame by the first sample, and this stays silent. A sample whose timing buffer was full can’t
 * count, so it’s skipped. The runner’s screenshots scroll to each diagram after the first sample, which loads it.
 * It can miss, never fire falsely, once a page has asked for as many pages as it has frames: requested counts every
 * diagram page since the load, in any conversation, so after a switch back, or once every frame has loaded, it stays
 * silent. O(samples² × frames²), with samples at most the run’s steps.
 * @param {{ probes?: { diagrams?: any[] } }} f
 */
function diagramDeferred(f) {
  const samples = (f.probes?.diagrams ?? []).filter((s) => !s.full);
  for (const [i, s] of samples.entries()) {
    if (s.requested >= s.frames.length) continue;
    const samePage = samples.slice(i + 1).filter((later) => later.origin === s.origin);
    const waiting = s.frames.filter((fr) => !fr.loaded && !fr.inView);
    for (const fr of waiting) {
      const drawn = samePage.find((later) => later.requested > s.requested && later.frames.some((x) => x.key === fr.key && x.loaded));
      if (!drawn) continue;
      return [
        {
          at: s.at,
          evidence: `At step ${s.step} the page had asked for ${s.requested} of its ${s.frames.length} diagram pages, and the diagram in ${fr.key} was out of view and not drawn; by step ${drawn.step} it had asked for ${drawn.requested}, and that diagram had drawn.`,
        },
      ];
    }
  }
  return [];
}

export const VIEW_TRIGGERS = {
  'diagram-deferred': {
    issue: 695,
    says: 'the page asked for fewer diagram pages than it had diagrams, and a diagram out of view loaded and drew later',
    recorded: (f) => Array.isArray(f.probes?.diagrams),
    run: diagramDeferred,
  },
};
