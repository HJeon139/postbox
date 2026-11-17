// A thread’s main state for its rail row (app/js/shell.mjs). Moved from app/js/client.mjs.

import { sessionsOf, sideSessionsOf } from './client.mjs';

/** The thread’s main state for its rail row: the most urgent of its agents, its side threads’ included (#121). */
export function threadState(t) {
  const ses = [...sessionsOf(t.id), ...sideSessionsOf(t.id)].filter((x) => !x.retiredFork);
  const rank = { needs: 5, failed: 4, tool: 3, gen: 3, think: 3, stopping: 1, idle: 0 };
  return ses.sort((a, b) => (rank[b.state] ?? 0) - (rank[a.state] ?? 0))[0];
}
