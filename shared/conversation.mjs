// Which conversation a thread belongs to, and which threads belong to a conversation: a topic or side thread hangs off
// its conversation by parentId. The client’s queue view (#427) reads it; #305’s archive pass is to read it too, so a
// thread can’t count in one and be missed by the other. (shared/needs.mjs’ conversationOf answers a different question:
// it falls back to the thread itself, for the needs-you view.)

/** How far up parentId is followed: a topic or side thread is one level today, and a loop must not hang. */
const MAX_HOPS = 8;

/**
 * The conversation a thread belongs to: itself, or the thread its parentId chain ends at.
 * @param {Record<string, { id: string, parentId?: string | null }>} threads @param {string} threadId
 * @returns {string | null} null when the thread isn’t there, or its chain is too deep or loops
 */
export function conversationRoot(threads, threadId) {
  let t = threads?.[threadId];
  for (let hops = 0; t?.parentId && threads[t.parentId]; hops++) {
    // Deeper than any thread Postbox makes, or a loop: no root is known, rather than a wrong one.
    if (hops === MAX_HOPS) return null;
    t = threads[t.parentId];
  }
  return t?.id ?? null;
}

/**
 * The ids of every thread in a conversation, the conversation first.
 * @param {Record<string, { id: string, parentId?: string | null }>} threads @param {string} convId
 */
export function threadsOfConversation(threads, convId) {
  const rest = Object.values(threads ?? {}).filter((t) => t.id !== convId && conversationRoot(threads, t.id) === convId);
  return threads?.[convId] ? [convId, ...rest.map((t) => t.id)] : [];
}
