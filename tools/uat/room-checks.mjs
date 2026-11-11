// Deterministic checks the UAT runs alongside the tester. Each finds one defect in `facts`, names its issue, and stays
// pure so tests can feed it fixtures.
//
// facts = {
//   state,           Postbox’s /api/state at the time
//   threads,         ids of the conversations and topic threads under test
//   startPersonas,   the personas a fresh install had
//   streams,         [{ handle, events, started, ended }]: each real turn’s raw stream (POSTBOX_CLAUDE_RECORD), with
//                    when its file was started (its name) and last written, in ms
//   events,          Postbox’s events for items and sessions, in order (tools/uat/history.mjs), for the checks that
//                    need what happened, not only the state now
//   kiroStreams,     [{ handle, events }]: each Kiro CLI turn’s raw stream (POSTBOX_KIRO_RECORD), kept apart: its
//                    lines are { type, data } around ACP session updates, which the Claude Code checks don’t read
//   agyStreams,      [{ handle, events }]: each Antigravity CLI turn’s raw stream (POSTBOX_AGY_RECORD), in a release
//                    run only: its lines are { event } (init, step_update, result)
//   transcripts,     [{ handle, lines }]: each agent’s Claude Code transcript, as text lines
//   console,         the page’s console errors and exceptions
//   apps,            { [itemId]: { text, marks, tinyMarks, svgText, tinyText, fonts } } read from inside each app
//   probes,          what the runner saw on the page, by kind (tools/uat/probes.mjs), such as answers: [{ key, revision, at }]
//   samples,         [{ busy: [handles thinking or calling tools], rows: number }]: the working row while agents worked
//   ui,              { headerText, reviewRawRows: { [itemId]: rows of a review block shown as raw “| … |” text } }
//   userMcpServers,  names of MCP servers in the person’s own Claude Code config
//   userRulesMarker, a line from the person’s global CLAUDE.md. Since #57, agents load the person’s setup on
//                    purpose, so it reaching them isn’t a finding; no check uses it now.
// }
//
// Each check names the inputs it reads (`inputs`), so facts with only some inputs run only those (liveChecks, below).

import { clip } from '../../shared/text.mjs';
import { AGENT_CHECKS } from './room-checks-agents.mjs';
import { APP_CHECKS } from './room-checks-apps.mjs';
import { ASK_CHECKS } from './room-checks-asks.mjs';
import { BACKEND_CHECKS } from './room-checks-backends.mjs';
import { DELIVERY_CHECKS } from './room-checks-delivery.mjs';
import { NEEDS_CHECKS } from './room-checks-needs.mjs';
import { P0_CHECKS } from './room-checks-p0.mjs';
import { PANEL_CHECKS } from './room-checks-panels.mjs';
import { REPLY_CHECKS } from './room-checks-replies.mjs';
import { SCREEN_CHECKS } from './room-checks-screen.mjs';
import { THREAD_CHECKS } from './room-checks-threads.mjs';
import { toolCalls } from './room-checks-tools.mjs';
import { VIEW_CHECKS } from './room-checks-view.mjs';
import { keptStreams, WORK_CHECKS } from './room-checks-work.mjs';
import { itemsOf } from './room-items.mjs';

export { callsFor, LONG_TURN_MS, LONG_TURN_TOOLS } from './block-use.mjs';
export { agyTokens, kiroCredits } from './room-checks-backends.mjs';
export { backgroundJobs, blockHistory } from './room-history.mjs';
export { waitingOnYou } from './waiting-on-you.mjs';

/** The checks the runner also runs while agents work, since what they catch can be gone by the time the turn ends. */
export const MID_TURN = ['background-step-closed', 'two-processes-one-session'];

export const CHECKS = [
  ...AGENT_CHECKS,
  ...REPLY_CHECKS,
  ...APP_CHECKS,
  ...SCREEN_CHECKS,
  // The Kiro CLI’s and the Antigravity CLI’s (#117, #143): tools/uat/room-checks-backends.mjs.
  ...BACKEND_CHECKS,
  ...THREAD_CHECKS,
  ...NEEDS_CHECKS,
  ...ASK_CHECKS,
  ...VIEW_CHECKS,
  ...DELIVERY_CHECKS,
  ...P0_CHECKS,
  {
    id: 'page-errors',
    inputs: ['console'],
    issue: null,
    run: (f) => {
      const errs = (f.console ?? []).filter((l) => !/Diagram: |Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(l));
      return errs.length
        ? [
            {
              title: 'The page logged errors',
              evidence: errs
                .slice(0, 3)
                .map((l) => clip(l, 160))
                .join(' | '),
            },
          ]
        : [];
    },
  },
  ...PANEL_CHECKS,
  ...WORK_CHECKS,
  {
    id: 'shell-off-silent',
    inputs: ['probes', 'state', 'threads', 'streams'],
    issue: 104,
    run: (f) =>
      (f.probes?.panels ?? []).flatMap((p) => {
        if (p.set?.shell !== false) return [];
        const after = keptStreams(f).filter((s) => s.handle === p.handle && (s.started ?? 0) > p.at);
        const refused = after.flatMap((s) => toolCalls(s.events).filter((c) => c.name === 'Bash' && (c.denied || c.result?.is_error)));
        if (!refused.length) return [];
        const shown = itemsOf(f).some((it) => it.kind === 'denial' && it.handle === p.handle && it.at > p.at);
        return shown
          ? []
          : [
              {
                title: 'A command refused because Shell is off didn’t show as refused',
                evidence: `@${p.handle} tried ${refused.length} command(s) after Shell was turned off, and no refused step or card shows.`,
              },
            ];
      }),
  },
];

/**
 * Runs every check, or only those named; each finding carries its check id and issue number. checks: another list to
 * run instead, as a test passes.
 * @param {any} facts  @param {{ only?: string[] | null, checks?: any[] }} [opts]
 */
export function runChecks(facts, { only = null, checks = CHECKS } = {}) {
  return checks
    .filter((c) => !only || only.includes(c.id))
    .flatMap((c) => {
      try {
        // A finding can set its own issue (null for information), and carry a verdict, a note and counts for the
        // report: the block counts for M1’s exit check do.
        return c.run(facts).map((x) => ({
          check: c.id,
          issue: x.issue === undefined ? c.issue : x.issue,
          key: x.key ?? c.id,
          title: x.title,
          evidence: x.evidence,
          ...(x.verdict ? { verdict: x.verdict, note: x.note } : {}),
          ...(x.counts ? { counts: x.counts } : {}),
          // A check it couldn’t make, for an agent on a backend whose inputs it can’t read: the report lists it.
          ...(x.unverified ? { unverified: x.unverified } : {}),
          // The requirements it serves (#508’s requirements.md), beside its issue, for a coverage table per requirement.
          ...(c.requirements ? { requirements: c.requirements } : {}),
        }));
      } catch (e) {
        return [{ check: c.id, issue: null, key: `${c.id}-error`, title: `The ${c.id} check failed`, evidence: e.message }];
      }
    });
}

// ── Facts without the page ──────────────────────────────────────────────────────────────────────────
// Postbox’s state, its events, the streams it recorded and the agents’ transcripts, but nothing the UAT’s driver reads
// off the page. A check that needs what it doesn’t have is listed as not run, with what it needed, instead of passing.

/** The facts there are without the page. */
export const LIVE_INPUTS = ['state', 'threads', 'streams', 'kiroStreams', 'agyStreams', 'codexStreams', 'events', 'transcripts'];

/**
 * The checks whose inputs these facts have, run; and the rest, with the inputs they’d need. What a check said it
 * couldn’t check, for an agent whose inputs it can’t read, is kept apart (unverified): it isn’t a finding.
 * @param {any} facts  @param {string[]} [have]
 * @returns {{ findings: ReturnType<typeof runChecks>, unverified: ReturnType<typeof runChecks>, ran: string[], notRun: { check: string, missing: string[] }[] }}
 */
export function liveChecks(facts, have = LIVE_INPUTS) {
  const can = CHECKS.filter((c) => c.inputs.every((i) => have.includes(i)));
  const all = runChecks(facts, { only: can.map((c) => c.id) });
  return {
    findings: all.filter((x) => !x.unverified),
    unverified: all.filter((x) => x.unverified),
    ran: can.map((c) => c.id),
    notRun: CHECKS.filter((c) => !can.includes(c)).map((c) => ({ check: c.id, missing: c.inputs.filter((i) => !have.includes(i)) })),
  };
}
