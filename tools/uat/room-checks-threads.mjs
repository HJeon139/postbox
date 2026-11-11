// Checks that a direct turn in a topic or historical side thread receives that thread’s request first (#504).

const ACCEPTED = new Set(['thread-task', 'slash', 'attach', 'system']);

/** @param {any} facts */
function missingThreadTasks(facts) {
  const turns = new Map();
  for (const threadId of facts.threads ?? []) {
    const thread = facts.state?.threads?.[threadId];
    if (thread?.kind !== 'topic' && thread?.kind !== 'side') continue;
    for (const item of facts.state?.items?.[threadId] ?? [])
      if (item.kind === 'agent' && item.turnId) turns.set(item.turnId, { threadId, handle: item.handle, first: item.promptFirst });
  }
  return [...turns].filter(([, turn]) => !ACCEPTED.has(turn.first)).map(([turnId, turn]) => ({ turnId, ...turn }));
}

export const THREAD_CHECKS = [
  {
    id: 'thread-request-first',
    inputs: ['state', 'threads'],
    issue: 504,
    run: (facts) =>
      missingThreadTasks(facts).map((turn) => ({
        key: turn.turnId,
        title: 'A thread turn did not put its request first',
        evidence: `@${turn.handle}’s turn ${turn.turnId} spoke in thread ${turn.threadId} without marking its first prompt section.`,
      })),
  },
];
