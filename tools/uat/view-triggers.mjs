// The long room’s view triggers (#508 lane, tests/uat/e2e/scenarios/bigroom.md): what the page draws far from the view.
// tools/uat/triggers.mjs adds them to TRIGGERS. Each reads the probes the runner records from the page
// (tools/uat/diagram-probe.mjs), not the state, since what’s drawn isn’t in it.

/**
 * How long after the page loads every frame it drew eagerly has loaded. A frame loads as its reply is drawn without
 * #701, in well under a second for one small diagram, so a frame still unloaded past this is one the page deferred.
 */
export const SETTLED_MS = 5000;

/**
 * A diagram out of view was still unloaded once the page had settled, and a later sample shows it drawn: the page
 * deferred it until it neared the view, and it drew once it did (#695, #701). The runner’s screenshots scroll to each
 * diagram after the first sample, which is the scroll that draws it.
 * @param {{ probes?: { diagrams?: any[] } }} f
 */
function diagramDeferred(f) {
  const samples = f.probes?.diagrams ?? [];
  for (const [i, s] of samples.entries()) {
    if (s.sinceLoad < SETTLED_MS) continue;
    for (const fr of s.frames) {
      if (fr.loaded || fr.inView) continue;
      const drawn = samples.slice(i + 1).find((later) => later.frames.some((x) => x.key === fr.key && x.loaded));
      if (!drawn) continue;
      const after = Math.round(s.sinceLoad / 1000);
      return [
        {
          at: s.at,
          evidence: `The diagram in ${fr.key} was out of view and not loaded ${after} s after the page loaded (step ${s.step}); it had drawn by step ${drawn.step}.`,
        },
      ];
    }
  }
  return [];
}

export const VIEW_TRIGGERS = {
  'diagram-deferred': {
    issue: 695,
    says: 'a diagram out of view stayed unloaded once the page settled, and drew once it was scrolled to',
    recorded: (f) => Array.isArray(f.probes?.diagrams),
    run: diagramDeferred,
  },
};
