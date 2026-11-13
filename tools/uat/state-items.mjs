// The run’s view of Postbox’s state (tools/uat/postbox.mjs’s api): /api/state carries the conversations but none of their
// items since #1155, which the page loads by range as it draws them. The runner’s checks and triggers read state.items,
// so each thread’s items are read from its items route, all of them, and put back where they were.

/**
 * The state with every thread’s items. A thread deleted between the two reads has none.
 * @param {any} state  /api/state’s state @param {(path: string) => Promise<any>} get  a GET on the run’s Postbox, as JSON
 */
export async function withItems(state, get) {
  const ids = Object.keys(state?.threads ?? {});
  const lists = await Promise.all(ids.map((id) => get(`/api/threads/${encodeURIComponent(id)}/items?limit=all`)));
  return { ...state, items: Object.fromEntries(ids.map((id, i) => [id, Array.isArray(lists[i]?.items) ? lists[i].items : []])) };
}
