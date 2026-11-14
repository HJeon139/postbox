// ── The Agents section, the Work ledger and the right pane (#105, #132, #146) ──────────────────────────────
// Moved out of tools/uat/room-checks.mjs, which spreads them into its CHECKS.

import { chosenText, ranDiffers, switchesOf } from './switch-facts.mjs';

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
    id: 'switch-takes-effect',
    inputs: ['probes', 'streams', 'sdkStreams', 'codexStreams', 'kiroStreams', 'agyStreams', 'events'],
    issue: 1315,
    run: (f) =>
      switchesOf(f).flatMap((s) => {
        const ran = ranDiffers(s);
        return ran
          ? [{ title: 'A switch saved in the persona sheet didn’t reach the agent’s next turn', evidence: `@${s.handle} saved ${chosenText(s)}; ${ran}` }]
          : [];
      }),
  },
  {
    id: 'switch-shown',
    inputs: ['probes', 'ui'],
    issue: 1315,
    run: (f) =>
      switchesOf(f)
        .filter((s) => s.turn && s.latest && /, not |, set to /.test(s.row ?? ''))
        .map((s) => ({
          title: 'After a switch and a turn, the agent’s row still says it runs something other than its setting',
          evidence: `@${s.handle} saved ${chosenText(s)}, and took a turn on ${s.turn?.backend}; its row says “${s.row}”.`,
        })),
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
