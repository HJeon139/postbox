// The one write gate for agent tools (#508's storage design, "When a write fails (ST-3)"): while the store can't be
// written, a tool that would write is refused with the cause, and a tool that only reads answers. server/mcp.mjs calls
// it for a local turn's tools and server/remote/turns-tools.mjs for a host's, so no path reaches a write tool around it
// (#637: a host's call had no gate, and its writes changed memory the next load didn't have).

/**
 * The tools that read and never write, the asset reads (#516) among them. Every rule about “a tool that only reads” is
 * this set: such a tool answers while the store is closed (closedTo); a scheduled wake’s recovery doesn’t name it
 * (scheduled-wakes.mjs); calling it isn’t an answer (empty-reply.mjs); and a host’s repeat of it runs it again rather
 * than being answered from a kept, cut copy (remote/turns-tools.mjs). A new read tool joins it here, and only here.
 */
export const READ_TOOLS = new Set(['read_conversation', 'read_message', 'corpus_search', 'list_assets', 'read_asset']);

/**
 * The cause to refuse a tool with while the store is closed, or null when it may run.
 * @param {any} rt @param {string} name @returns {string | null}
 */
export const closedTo = (rt, name) => (!rt.store.writable && !READ_TOOLS.has(name) ? rt.store.cause.message : null);
