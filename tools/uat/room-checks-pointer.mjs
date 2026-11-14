// The runner’s clicks (#1320, #1327): what it aimed at moved before it clicked, as a button moving under a person’s
// pointer does. The runner clicks where it ended up, so the run goes on, and records the move
// (tools/uat/driver-pointer.mjs, facts.probes.targetMoved); this check makes it a finding. AGENTS.md: a notice “never
// moves a button under the pointer”. A run from before the probe has none, and stays silent.

const at = (p) => `(${Math.round(p.x * 10) / 10}, ${Math.round(p.y * 10) / 10})`;

/** @param {{ probes?: { targetMoved?: { step: number, what: string, from: { x: number, y: number }, to: { x: number, y: number } }[] } }} f */
function targetMoved(f) {
  return (f.probes?.targetMoved ?? []).map((m) => ({
    key: `target-moved:${m.step}:${m.what}`,
    title: 'A button moved under the pointer',
    evidence: `At step ${m.step}, ${m.what} moved from ${at(m.from)} to ${at(m.to)} between the runner aiming at it and clicking.`,
  }));
}

export const POINTER_CHECKS = [{ id: 'target-moved', inputs: ['probes'], issue: 1327, run: targetMoved }];
