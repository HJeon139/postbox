// A conversation keeps its Work open until you close it, in this browser: a link to the conversation or one of its
// threads opens Work beside it again. Opening and closing it replace the address rather than add to the history,
// like the rail, so Back goes to where you were, not to the pane as it was.
const workKey = (threadId) => `pb-work-${threadId}`;
/** Whether Work was left open in a conversation. */
export function workRemembered(threadId) {
  try {
    return localStorage.getItem(workKey(threadId)) === '1';
  } catch {
    return false;
  }
}
export function rememberWork(threadId, open) {
  try {
    if (open) localStorage.setItem(workKey(threadId), '1');
    else localStorage.removeItem(workKey(threadId));
  } catch {}
}
