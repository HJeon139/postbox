// The server’s checks over a finished turn (#58, #63, #98): the terms, diagrams, raw HTML and missing blocks in its
// reply, which become its lint turn, and the progress steps it left running, marked stalled. A turn that was stopped
// or failed starts no lint turn, so its agent hears of the stalled steps at its next turn instead. Moved out of
// server/runtime.mjs; Runtime keeps a method of the same name that delegates here.

import { lintDiagrams } from '../shared/diagram-lint.mjs';
import { blockProblems, diagramProblems, introducedTerms, personSaid, rawHtmlProblems, termProblems } from './checks.mjs';

/** The server’s checks over a finished turn. */
export function checkTurn(rt, turn, se) {
  const lineage = rt.lineage(turn.threadId);
  const items = lineage.flatMap((id) => rt.store.pending.items(id));
  const apps = Object.values(rt.store.pending.apps()).filter((a) => lineage.includes(a.threadId));
  const problems = termProblems(turn.said, rt.glossaryFor(turn.threadId), introducedTerms(items, apps), personSaid(items));
  // Diagrams too wide or too busy to read at the conversation’s width.
  const diagrams = lintDiagrams(turn.said);
  if (diagrams.length)
    rt.rememberDiagrams(
      se.id,
      diagrams.map((d) => d.src),
    );
  problems.push(...diagramProblems(diagrams), ...rawHtmlProblems(turn.said));
  // A reply that should have been a block (#63): what this turn showed, and what the person last asked for.
  const own = rt.store.pending.items(turn.threadId);
  const shown = own.filter((it) => it.kind === 'block' && it.valid && it.turnId === turn.id).map((it) => it.block.type);
  problems.push(...blockProblems(turn.said, shown, own.findLast((it) => it.kind === 'user')?.text ?? ''));
  return problems;
}

/**
 * A turn that was stopped or failed starts no lint turn, but its progress steps still running show as stalled, as
 * at a normal end (#58), and the agent hears which at the start of its next turn (#98).
 * @param {any} turn @param {any} se @param {'stopped' | 'failed' | 'shutdown' | 'hung'} how
 */
export function stallLeftRunning(rt, turn, se, how) {
  const problems = rt.stallSteps(turn, se);
  if (!problems.length) return;
  const blocks = problems.map((p) => `- Block “${p.scope.title ?? p.scope.id}” (id ${p.scope.id}): ${p.message}`);
  rt.tellAgent(
    se.id,
    `${{ stopped: 'The person stopped your last turn', failed: 'Your last turn failed', shutdown: 'Postbox shut down during your last turn', hung: 'Postbox stopped your last turn, which had no output for too long,' }[how]} while progress steps were running:\n${blocks.join('\n')}`,
  );
}

/**
 * Progress steps still running when their agent’s turn ends are marked stalled, and the agent is told to close them.
 * Not the steps that were running when the person kept its background jobs running, while one runs on (#129): such
 * a step may follow the job, and they stall when the last one ends (endJob).
 * @param {{ threadId: string, keepJobs?: Set<string> }} turn
 */
export function stallSteps(rt, turn, se) {
  const problems = [];
  const runsOn = turn.keepJobs?.size || (se.jobs ?? []).some((j) => j.kept);
  const held = new Set(runsOn ? (se.heldSteps?.keys ?? []) : []);
  for (const it of rt.store.pending.items(turn.threadId)) {
    if (it.kind !== 'block' || !it.valid || it.sessionId !== se.id || it.block.type !== 'progress') continue;
    const stalls = (s) => s.state === 'running' && !held.has(`${it.id}:${s.id}`);
    const running = it.block.steps.filter(stalls);
    if (!running.length) continue;
    const steps = it.block.steps.map((s) => (stalls(s) ? { ...s, state: 'stalled' } : s));
    rt.patchItem(turn.threadId, it.id, { block: { ...it.block, steps }, stalledAt: Date.now() });
    const names = running.map((s) => `“${s.label}”`);
    const one = running.length === 1;
    problems.push({
      code: 'steps-left-running',
      message: `${one ? 'Step' : 'Steps'} ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]} ${one ? 'was' : 'were'} still running when your turn ended, so the person sees ${one ? 'it' : 'them'} as stalled. Close each with update_block, as done or failed.`,
      scope: { kind: 'block', id: it.block.id, title: it.block.title },
    });
  }
  return problems;
}
