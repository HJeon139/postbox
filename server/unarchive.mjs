// Conversations can’t be archived any more: a store an older Postbox wrote can still hold an archived one (#101, #320),
// and a fork #228 retired as archived. As the store loads, each archived conversation and its agents come back as live
// ones, and a retired fork keeps only retiredFork, the flag that keeps it out of the rail and that no message reaches.

import { pendingThreads, updateThread } from './thread-write.mjs';

/**
 * Drops `archived` from every thread and session that still has it. O(threads + sessions), and it writes nothing once
 * a store has none. @param {import('./runtime.mjs').Runtime} rt
 */
export function unarchive(rt) {
  for (const t of pendingThreads(rt)) if (Object.hasOwn(t, 'archived')) updateThread(rt, t.id, { archived: undefined });
  for (const id of Object.keys(rt.s.sessions)) {
    const se = rt.store.pending.session(id);
    if (se && (Object.hasOwn(se, 'archived') || Object.hasOwn(se, 'archivedAt'))) rt.updateSession(id, { archived: undefined, archivedAt: undefined });
  }
}
