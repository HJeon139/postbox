// Who needs you, where, and in what order (#285). The page’s ⌃J, its needs-you rings and rows, and the UAT’s check of
// where they land all read these rules, so they can’t disagree about which agent comes next.

/** What a session can need you for. Every one makes its ring pulse, so every one counts (#285): a refused step too. */
export const NEEDS_KINDS = ['block', 'failed', 'hop', 'permission', 'appsend', 'denial', 'toolask'];

/** @param {any} se */
export const needsYouNow = (se) => !!se?.needs && NEEDS_KINDS.includes(se.needs.kind);

/**
 * The thread an agent’s ask is in: its side or topic thread when it asked there (#121), else where its turn runs.
 * @param {any} state  @param {any} se
 */
export const whereNeeds = (state, se) =>
  (se.needs?.threadId && state.threads[se.needs.threadId] ? se.needs.threadId : null) ?? se.sideTurn?.threadId ?? se.threadId;

/** The conversation a thread belongs to: itself, or the one its side or topic thread hangs off. */
export function conversationOf(state, threadId) {
  let t = state.threads[threadId];
  for (let hops = 0; t && (t.kind === 'side' || t.kind === 'topic') && state.threads[t.parentId] && hops < 8; hops++) t = state.threads[t.parentId];
  return t?.id ?? threadId;
}

/** When an agent started waiting on you: when its ask was posted, or failing that, its session’s last change. */
export function waitedSince(state, se) {
  const it = (state.items[whereNeeds(state, se)] ?? []).find((x) => x.id === se.needs?.itemId);
  return it?.at ?? se.updatedAt ?? 0;
}

/**
 * The agents that need you, the one that has waited longest first. With `here` (a conversation’s id), that
 * conversation’s agents (its side and topic threads’ too) come first, then the rest.
 * @param {any} state  @param {any[]} sessions  @param {string|null} [here]
 */
export function needsOrder(state, sessions, here = null) {
  const at = new Map(sessions.map((se) => [se.id, waitedSince(state, se)]));
  const near = (se) => (here && conversationOf(state, whereNeeds(state, se)) === here ? 0 : 1);
  return sessions.filter(needsYouNow).sort((a, b) => near(a) - near(b) || (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0) || a.id.localeCompare(b.id));
}
