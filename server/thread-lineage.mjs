// A thread’s place in its conversation (#101, #110, #121): the threads it branched from (its lineage), every thread of
// the conversation it belongs to, and the glossary it inherits along its lineage. Moved out of server/runtime.mjs;
// Runtime keeps a method of each name that delegates here.

/**
 * Every thread of a thread’s conversation: its lineage first, then the conversation’s other side and topic threads.
 * What read_conversation { thread } and read_message may read.
 * @param {string} threadId
 */
export function conversationThreads(rt, threadId) {
  const own = rt.lineage(threadId);
  const root = own.at(-1);
  const rest = Object.values(rt.s.threads)
    .filter((t) => !own.includes(t.id) && rt.lineage(t.id).at(-1) === root)
    .map((t) => t.id);
  return [...own, ...rest];
}

/** A thread, then the conversation it branched from, following parentId (a topic or side thread’s is one level), as `thread` reads one. */
export function lineage(rt, threadId, thread = (/** @type {string} */ id) => rt.s.threads[id]) {
  const out = [];
  for (let id = threadId; id && thread(id) && !out.includes(id) && out.length < 8; id = thread(id).parentId) out.push(id);
  return out;
}

/**
 * The terms a thread knows: its own glossary over its parent’s, so a topic thread inherits its conversation’s
 * terms and its own definition wins. The browser’s glossaryOf (app/js/thread.mjs) merges the same way.
 */
export function glossaryFor(rt, threadId) {
  return Object.assign(
    {},
    ...rt
      .lineage(threadId)
      .map((id) => rt.s.glossary[id] ?? {})
      .reverse(),
  );
}
