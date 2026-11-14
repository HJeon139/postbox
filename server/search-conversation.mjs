// search_conversation (#1340; CX-5 of #508, designs/508/requirements.md, “Agent context”): an agent finds an item of its
// conversation, or of one of its topic and side threads, by words, where read_conversation only pages through them in
// order. It reads the index the page’s search box reads (server/thread-search.mjs), so there is one index per thread,
// and it shows each hit as read_conversation shows an item, cut to the words around the match.

import { SEARCHING } from '../shared/limits.mjs';
import { clipText } from './helpers.mjs';
import { searchOf } from './thread-search.mjs';

const count = (/** @type {number} */ n) => n.toLocaleString('en-US');

/**
 * The words around the first match in an item’s line, or the whole line when it’s short. A long line keeps who wrote
 * it, and says how long it is and that read_message has all of it.
 * @param {string} line  the item as read_conversation gives it, uncut @param {string[]} terms  the words that matched @param {string} id
 */
function snippet(line, terms, id) {
  if (line.length <= SEARCHING.snippet) return line;
  const low = line.toLowerCase();
  const found = terms.map((t) => low.indexOf(t)).filter((at) => at >= 0);
  const at = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, at - Math.floor(SEARCHING.snippet / 3));
  // Who wrote it leads the line (“@critic: …”); a snippet from further in keeps that.
  const colon = line.indexOf(': ');
  const who = start > 0 && colon >= 0 && colon < 120 ? line.slice(0, colon + 2) : '';
  const words = line.slice(start, start + SEARCHING.snippet).trim();
  return `${who}${start > 0 ? '…' : ''}${words}… (${count(line.length)} characters; read_message { id: "${id}" } has all of it)`;
}

/** When an item was posted, to the minute, so an agent can tell an early decision from the one that replaced it. */
const when = (/** @type {any} */ item) => (Number.isFinite(item.at) ? `${new Date(item.at).toISOString().slice(0, 16).replace('T', ' ')} UTC · ` : '');

/**
 * search_conversation: the items of the agent’s conversation and its topic and side threads that match the query’s
 * words, best first, each with its id, when it was posted, the thread it’s in when that isn’t the conversation, who
 * wrote it and the words around the match.
 * @param {any} rt @param {any} se @param {{ query?: unknown, limit?: unknown }} [args]
 * @returns {{ ok: boolean, message: string }}
 */
export function searchConversation(rt, se, args = {}) {
  if (typeof args?.query !== 'string' || !args.query.trim()) return { ok: false, message: 'search_conversation needs a query: the words to look for.' };
  const query = args.query.trim().slice(0, SEARCHING.query);
  const k = Math.max(1, Math.min(SEARCHING.most, Math.floor(Number(args.limit)) || SEARCHING.hits));
  const search = searchOf(rt.store);
  const hits = rt.threads
    .conversationThreads(se.threadId)
    .flatMap((threadId) => search.search(threadId, query, k).map((hit) => ({ ...hit, threadId })))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  const asked = `“${clipText(query, 80)}”`;
  const lines = hits.flatMap((hit) => {
    const item = rt.store.item(hit.threadId, hit.id);
    const line = item ? rt.readLine(item, se, Number.POSITIVE_INFINITY) : '';
    if (!line) return [];
    const t = hit.threadId === se.threadId ? null : rt.s.threads[hit.threadId];
    const where = t ? `in the ${t.kind === 'side' ? 'side thread' : 'thread'} “${clipText(String(t.title ?? ''), 80)}” (${t.id}) · ` : '';
    return [`[${hit.id}] ${when(item)}${where}${snippet(line, hit.terms, hit.id)}`];
  });
  if (!lines.length)
    return { ok: true, message: `Nothing in this conversation matches ${asked}. Try other words, or read_conversation, which reads it in order.` };
  return { ok: true, message: `${count(lines.length)} ${lines.length === 1 ? 'item matches' : 'items match'} ${asked}, best first:\n\n${lines.join('\n\n')}` };
}
