// Which conversation a thread belongs to, and which threads belong to a conversation: a topic or side thread hangs off
// its conversation by parentId. The client’s queue view (#427) and the server’s archive pass (#305) read the same
// answer from here, so a thread can’t count in one and be missed by the other.

/** How far up parentId is followed: a topic or side thread is one level today, and a loop must not hang. */
const MAX_HOPS = 8;

/**
 * The conversation a thread belongs to: itself, or the thread its parentId chain ends at.
 * @param {Record<string, { id: string, parentId?: string | null }>} threads @param {string} threadId
 * @returns {string | null} null when the thread isn’t there
 */
export function conversationOf(threads, threadId) {
  let t = threads?.[threadId];
  for (let hops = 0; t?.parentId && threads[t.parentId] && hops < MAX_HOPS; hops++) t = threads[t.parentId];
  return t?.id ?? null;
}

/**
 * The ids of every thread in a conversation, the conversation first.
 * @param {Record<string, { id: string, parentId?: string | null }>} threads @param {string} convId
 */
export function threadsOfConversation(threads, convId) {
  const rest = Object.values(threads ?? {}).filter((t) => t.id !== convId && conversationOf(threads, t.id) === convId);
  return threads?.[convId] ? [convId, ...rest.map((t) => t.id)] : [];
}
