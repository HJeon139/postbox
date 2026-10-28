// Checks that a turn in a topic or historical side thread receives that thread’s request before room background (#504).

/** @param {any} facts */
function missingThreadTasks(facts) {
  const first = new Map((facts.events ?? []).filter((event) => event.type === 'turn.context').map((event) => [event.data?.turnId, event.data?.first]));
  const turns = new Map();
  for (const threadId of facts.threads ?? []) {
    const thread = facts.state?.threads?.[threadId];
    if (thread?.kind !== 'topic' && thread?.kind !== 'side') continue;
    for (const item of facts.state?.items?.[threadId] ?? [])
      if (item.kind === 'agent' && item.turnId) turns.set(item.turnId, { threadId, handle: item.handle });
  }
  return [...turns].filter(([turnId]) => first.get(turnId) !== 'thread-task').map(([turnId, turn]) => ({ turnId, ...turn }));
}

export const THREAD_CHECKS = [
  {
    id: 'thread-request-first',
    inputs: ['state', 'threads', 'events'],
    issue: 504,
    run: (facts) =>
      missingThreadTasks(facts).map((turn) => ({
        key: turn.turnId,
        title: 'A thread turn did not put its request first',
        evidence: `@${turn.handle}’s turn ${turn.turnId} spoke in thread ${turn.threadId} without recording its thread request as the first prompt section.`,
      })),
  },
];
