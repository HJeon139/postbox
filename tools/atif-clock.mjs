// A run clock’s events as a trajectory’s system steps (tools/atif.mjs, server/run-clock.mjs). Moved from
// tools/atif.mjs, which keeps its length limit.

/** Each clock event’s words, from its data. @type {Record<string, (d: any) => string>} */
export const CLOCK_WORDS = {
  'clock.started': (d) => `Run clock started with a budget of ${d.budgetMs / 1000}s.`,
  'clock.paused': () => 'Run clock paused: Postbox stopped the agent until it resumes.',
  'clock.resumed': () => 'Run clock resumed.',
  'clock.turn': (d) => `Turn started at elapsed ${Math.floor(d.elapsedMs / 1000)}s of ${d.budgetMs / 1000}s.`,
  'clock.restored': (d) =>
    `Postbox started again with the run clock at elapsed ${Math.floor(d.elapsedMs / 1000)}s of ${d.budgetMs / 1000}s; the time it was down counted.`,
  'clock.expired': (d) => `Run clock expired at its budget of ${d.budgetMs / 1000}s: Postbox stopped the agent.`,
};
