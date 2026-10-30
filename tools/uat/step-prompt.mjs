// What the tester reads at each step of a run: the phase, what its last action did, what changed on screen, what’s
// waiting on it, and what the checks found (tools/uat-run.mjs builds it before every tester call).

/**
 * The step’s prompt for the tester.
 * @param {{ step: number, steps: number, phase: number, scenario: any, goal: { note?: string }, lastAction: any, actionError: string|null, actionResult: string|null, timedOut: string|null, obs: { items: string[], states: string[] }, waiting: string[], jobsAsk: string|null, fresh: any[] }} o
 */
export function stepPrompt({ step, steps, phase, scenario, goal, lastAction, actionError, actionResult, timedOut, obs, waiting, jobsAsk, fresh }) {
  const ph = scenario.phases[phase];
  return [
    `Step ${step} of at most ${steps}. Phase ${phase + 1} of ${scenario.phases.length}: ${ph.title}`,
    ph.text,
    goal.note,
    lastAction
      ? `Your last action: ${JSON.stringify(lastAction)}${actionError ? `. It failed: ${actionError}` : ''}${actionResult ? `. Result: ${actionResult}` : ''}`
      : phase
        ? `Nothing has happened yet. This run starts at phase ${phase + 1}, skipping the ones before it, so first set up briefly what this phase needs (the earlier phases are only context): ${scenario.phases
            .slice(0, phase)
            .map((p) => p.title)
            .join('; ')}.`
        : 'Nothing has happened yet: start the phase.',
    timedOut ? `The run itself pressed Stop: ${timedOut} A “Stopped by you” line is from that, not a bug.` : '',
    obs.items.length ? `What changed on screen:\n\n${obs.items.join('\n\n')}` : 'Nothing changed on screen.',
    `Agents: ${obs.states.join('; ') || 'none yet'}`,
    waiting.length ? `Waiting on you:\n${waiting.map((w) => `- ${w}`).join('\n')}` : 'Nothing is waiting on you.',
    jobsAsk ? `Postbox is asking about background jobs: “${jobsAsk}” Answer it with jobs.` : '',
    fresh.length ? `The automatic checks found:\n${fresh.map((f) => `- ${f.title}${f.issue ? ` (#${f.issue})` : ''}: ${f.evidence}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
