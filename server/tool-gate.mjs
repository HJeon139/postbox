// The one write gate for agent tools (#508's storage design, "When a write fails (ST-3)"): while the store can't be
// written, a tool that would write is refused with the cause, and a tool that only reads answers. server/mcp.mjs calls
// it for a local turn's tools and server/remote/turns-tools.mjs for a host's, so no path reaches a write tool around it
// (#637: a host's call had no gate, and its writes changed memory the next load didn't have).

/** The tools that read and never write: they answer while the store is closed. */
export const READ_TOOLS = new Set(['read_conversation', 'read_message', 'corpus_search']);

/**
 * The cause to refuse a tool with while the store is closed, or null when it may run.
 * @param {any} rt @param {string} name @returns {string | null}
 */
export const closedTo = (rt, name) => (!rt.store.writable && !READ_TOOLS.has(name) ? rt.store.cause.message : null);
