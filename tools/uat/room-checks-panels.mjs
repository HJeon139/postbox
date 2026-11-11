// ── The Agents section, the Work ledger and the right pane (#105, #132, #146) ──────────────────────────────
// Moved out of tools/uat/room-checks.mjs, which spreads them into its CHECKS.

/** A model as the panel names it (“Opus 5.5”) and as a stream names it (“claude-opus-5-5”), reduced to compare. */
const modelKey = (m) =>
  String(m ?? '')
    .toLowerCase()
    .replace(/^claude-/, '')
    .replace(/[^a-z0-9]/g, '');

export const PANEL_CHECKS = [
  {
    id: 'agents-section-members',
    inputs: ['ui', 'state', 'threads'],
    issue: 105,
    run: (f) => {
      if (!Array.isArray(f.ui?.agentRows) || !f.threads.length) return [];
      const main = f.state.threads[f.threads[0]];
      const members = (main?.members ?? [])
        .map((id) => f.state.sessions[id])
        .filter((se) => se && !se.archived)
        .map((se) => se.handle);
      const missing = members.filter((h) => !f.ui.agentRows.includes(h));
      return missing.length
        ? [
            {
              title: 'An agent in the conversation has no row in the Agents section',
              evidence: `Missing: @${missing.join(', @')}. Rows: ${f.ui.agentRows.map((h) => `@${h}`).join(', ') || 'none'}.`,
            },
          ]
        : [];
    },
  },
  {
    id: 'topbar-title-cut',
    inputs: ['ui'],
    issue: 105,
    run: (f) =>
      f.ui?.topbarCut
        ? [
            {
              title: 'The top bar cuts the conversation’s title or project at a wide window',
              evidence: 'A title or crumb in the top bar is narrower than its text at 1200 px or wider.',
            },
          ]
        : [],
  },
  {
    id: 'quick-panel-takes-effect',
    inputs: ['probes', 'streams'],
    issue: 105,
    run: (f) =>
      (f.probes?.panels ?? []).flatMap((p) => {
        if (!p.set?.model) return [];
        const next = (f.streams ?? []).filter((s) => s.handle === p.handle && (s.started ?? 0) > p.at).sort((a, b) => (a.started ?? 0) - (b.started ?? 0))[0];
        const model = next?.events.find((e) => e.type === 'system' && e.subtype === 'init')?.model;
        if (!model || modelKey(model).includes(modelKey(p.set.model))) return [];
        return [
          {
            title: 'A model picked in the quick panel didn’t reach the agent’s next turn',
            evidence: `Picked “${p.set.model}” for @${p.handle}; its next turn ran ${model}.`,
          },
        ];
      }),
  },
  {
    id: 'pane-split',
    inputs: ['probes'],
    issue: 146,
    run: (f) =>
      (f.probes?.panes ?? [])
        .filter((p) => p.work && p.thread && Math.min(p.work.h, p.thread.h) < 120)
        .map((p) => ({
          title: 'With a thread and Work open, one of them is too short to use',
          evidence: `Work ${p.work.w}×${p.work.h}, thread ${p.thread.w}×${p.thread.h}.`,
        })),
  },
  {
    id: 'fullscreen-keeps-draft',
    inputs: ['probes'],
    issue: 146,
    run: (f) =>
      (f.probes?.drafts ?? [])
        .filter((d) => {
          // A thread at its end stays at its end; anywhere else, it stays where it was.
          const at = (x) => (typeof x === 'object' && x ? x : { top: x ?? 0, gap: Number.POSITIVE_INFINITY });
          const [b, a] = [at(d.before), at(d.after)];
          const moved = b.gap <= 2 ? a.gap > 2 : Math.abs(a.top - b.top) > 2;
          return !d.kept || !d.exited || moved;
        })
        .map((d) => ({
          title: 'A thread lost its place going full screen and back',
          evidence: `${d.kept ? 'The draft was kept' : `The draft became ${JSON.stringify(d.draft)}`}; ${d.exited ? 'full screen closed' : 'full screen didn’t close'}; scrolled ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}.`,
        })),
  },
];
