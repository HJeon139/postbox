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
