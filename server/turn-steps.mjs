// How a turn’s activity steps settle when it ends. Moved from server/runtime.mjs; each function takes the runtime first.

/**
 * A subagent that worked in the background, and its own calls, still running when its turn ends: nothing will say
 * how they ended now (Stop, or its CLI exited without saying), so they read as stopped (#73).
 */
export function settleSubagentSteps(rt, turn) {
  const open = new Set((turn.steps ?? []).filter((s) => s.kind === 'agent' && s.state === 'running').map((s) => s.id));
  if (!open.size) return;
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of turn.steps)
      if (s.state === 'running' && !s.job && s.parent && open.has(s.parent) && !open.has(s.id)) {
        open.add(s.id);
        grew = true;
      }
  }
  turn.steps = turn.steps.map((s) => (open.has(s.id) ? { ...s, state: 'stopped', detail: 'its turn ended before it finished' } : s));
  if (turn.first) rt.patchItem(turn.threadId, turn.first, { activity: { steps: [...turn.steps] } });
}

/**
 * Stop settles every step its turn hadn’t finished (#288): the turn takes no more activity, so nothing would say how a
 * call still running ended, and its reply would read as running. A background job’s step Stop keeps running stays
 * as it is, since the job runs on; another job’s step reads stopped now, and its end, when its CLI reports it, says how.
 */
export function settleStoppedSteps(rt, turn) {
  settleSubagentSteps(rt, turn);
  const open = (s) => s.state === 'running' && !(s.job && turn.keepJobs.has(s.job));
  if (!(turn.steps ?? []).some(open)) return;
  turn.steps = turn.steps.map((s) => (open(s) ? { ...s, state: 'stopped' } : s));
  if (turn.first) rt.patchItem(turn.threadId, turn.first, { activity: { steps: [...turn.steps] } });
}
