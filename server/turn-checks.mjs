// The server’s checks over a finished turn (#58, #63, #98): the terms, diagrams, raw HTML and missing blocks in its
// reply, which become its lint turn, and the progress steps it left running, marked stalled, or failed when the turn
// failed (#664). A turn that was stopped or failed starts no lint turn, so its agent hears of those steps at its next
// turn instead. Checks
// (server/check-service.mjs) calls each with itself.

import { lintDiagrams } from '../shared/diagram-lint.mjs';
import { blockProblems, diagramProblems, introducedTerms, personSaid, rawHtmlProblems, termProblems } from './checks.mjs';
import { rememberDiagrams, syntaxCheck } from './diagram-check.mjs';
import { endLint, quietLint } from './lint-delivery.mjs';
import { backTo } from './reply-back.mjs';

/**
 * The checks: what this turn sent, as problems, which go back to the agent in one lint turn. A lint turn is
 * never linted again, so this can’t loop; one that only called tools ends as a note instead of a reply.
 * @param {import('./check-service.mjs').Checks} checks @param {any} turn @param {any} se
 */
export function endChecks(checks, turn, se) {
  const stalled = stallSteps(checks, turn, se);
  if (turn.kind === 'lint') return quietLint(checks, turn, se);
  // The diagrams reported before this turn: its own, which the estimate may flag now, still get their syntax checked.
  const before = new Set(checks.store.state.sessions[se.id]?.diagramsLinted ?? []);
  endLint(checks, turn, [...checkTurn(checks, turn, se), ...stalled]);
  syntaxCheck(checks, turn, before).catch((e) => console.error(`Postbox couldn’t check a diagram’s syntax; the page still reports it: ${e.message}`));
}

/** The server’s checks over a finished turn. */
export function checkTurn(checks, turn, se) {
  const lineage = checks.threads.lineage(turn.threadId);
  const items = lineage.flatMap((id) => checks.store.pending.items(id));
  const apps = Object.values(checks.store.pending.apps()).filter((a) => lineage.includes(a.threadId));
  const problems = termProblems(turn.said, checks.threads.glossaryFor(turn.threadId), introducedTerms(items, apps), personSaid(items));
  // Diagrams too wide or too busy to read at the conversation’s width.
  const diagrams = lintDiagrams(turn.said);
  if (diagrams.length)
    rememberDiagrams(
      checks,
      se.id,
      diagrams.map((d) => d.src),
    );
  problems.push(...diagramProblems(diagrams), ...rawHtmlProblems(turn.said));
  // A reply that should have been a block (#63): what this turn showed, and what the person last asked for. A reply to
  // another agent is that agent’s to answer (#1695): one whose @-mention woke an agent or waits for one (`mentioned`,
  // set by mention-entries.mjs from the replies alone, not by open_topic or a review), or one that goes back to the
  // agents whose mentions woke the turn, as reply-back decides it.
  const own = checks.store.pending.items(turn.threadId);
  const shown = own.filter((it) => it.kind === 'block' && it.valid && it.turnId === turn.id).map((it) => it.block.type);
  const toAgent = (turn.mentioned?.length ?? 0) > 0 || (turn.backTo ?? backTo(turn.asked?.message?.entries ?? [])).length > 0;
  problems.push(...blockProblems(turn.said, shown, own.findLast((it) => it.kind === 'user')?.text ?? '', { toAgent }));
  return problems;
}

/**
 * A turn that was stopped or failed starts no lint turn, but its progress steps still running show as stalled, as
 * at a normal end (#58), and the agent hears which at the start of its next turn (#98). A failed turn’s show as
 * failed instead, so the person can tell an error from a step that stopped answering (#664).
 * @param {any} turn @param {any} se @param {'stopped' | 'failed' | 'lost' | 'shutdown' | 'hung'} how
 */
export function stallLeftRunning(checks, turn, se, how) {
  const problems = stallSteps(checks, turn, se, how === 'failed' ? 'failed' : 'stalled');
  if (!problems.length) return;
  const blocks = problems.map((p) => `- Block “${p.scope.title ?? p.scope.id}” (id ${p.scope.id}): ${p.message}`);
  checks.sessions.tell(
    se.id,
    `${{ stopped: 'The person stopped your last turn', failed: 'Your last turn failed', lost: 'Your last turn lost its connection', shutdown: 'Postbox shut down during your last turn', hung: 'Postbox stopped your last turn, which had no output for too long,' }[how]} while progress steps were running:\n${blocks.join('\n')}`,
  );
}

/**
 * How a failed turn’s progress steps end (#664): failed only when the turn really failed. A turn lost to the network
 * and sent again goes on as the resend, and a host turn whose link was lost goes on on its host (mention-entries.mjs
 * reads it the same way), so their steps stall, as at a stop.
 * @param {any} turn @param {any} se @param {boolean} resends
 * @returns {'failed' | 'lost'}
 */
export function failedHow(turn, se, resends) {
  return resends || turn.endErr?.remote || se.remoteTurn?.state === 'lost' ? 'lost' : 'failed';
}

/**
 * Progress steps still running when their agent’s turn ends are marked stalled, or failed when the turn failed, and
 * the agent is told to close them. Not the steps that were running when the person kept its background jobs running,
 * while one runs on (#129): such a step may follow the job, and they stall when the last one ends (endJob).
 * @param {{ threadId: string, keepJobs?: Set<string> }} turn @param {'stalled' | 'failed'} [to]
 */
export function stallSteps(checks, turn, se, to = 'stalled') {
  const problems = [];
  const runsOn = turn.keepJobs?.size || (se.jobs ?? []).some((j) => j.kept);
  const held = new Set(runsOn ? (se.heldSteps?.keys ?? []) : []);
  for (const it of checks.store.pending.items(turn.threadId)) {
    if (it.kind !== 'block' || !it.valid || it.sessionId !== se.id || it.block.type !== 'progress') continue;
    const stalls = (s) => s.state === 'running' && !held.has(`${it.id}:${s.id}`);
    const running = it.block.steps.filter(stalls);
    if (!running.length) continue;
    const steps = it.block.steps.map((s) => (stalls(s) ? { ...s, state: to } : s));
    checks.threads.patchItem(turn.threadId, it.id, { block: { ...it.block, steps }, ...(to === 'stalled' ? { stalledAt: Date.now() } : {}) });
    const names = running.map((s) => `“${s.label}”`);
    const one = running.length === 1;
    const listed = `${one ? 'Step' : 'Steps'} ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]} ${one ? 'was' : 'were'}`;
    problems.push({
      code: 'steps-left-running',
      message:
        to === 'failed'
          ? `${listed} still running when your turn failed, so the person sees ${one ? 'it' : 'them'} as failed. If ${one ? 'it' : 'one'} finished, mark it done with update_block.`
          : `${listed} still running when your turn ended, so the person sees ${one ? 'it' : 'them'} as stalled. Close each with update_block, as done or failed.`,
      scope: { kind: 'block', id: it.block.id, title: it.block.title },
    });
  }
  return problems;
}
