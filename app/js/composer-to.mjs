// Who a message from the composer goes to, as sendMessage decides it (server/runtime.mjs), for the composer’s hint: a
// message that @-mentions no one goes to the next speaker, and one that names an agent without its @ may not reach it
// (#134).

import { unaddressed } from '/shared/text.mjs';
import { mockMarker } from './agent-facts.mjs';
import { handles } from './agent-markdown.mjs';
import { S, sessionsOf } from './client.mjs';
import { h } from './dom.mjs';

/**
 * Who answers a message that @-mentions no one: in a conversation, the agent that spoke last, else its first; in a
 * topic or side thread, the agent that spoke last there, else the one it started with (threadPersona,
 * server/side-threads.mjs), from its session in the conversation. last: it spoke last. Null when there’s no one.
 * @param {string} threadId @returns {{ handle: string, agent: any, last: boolean } | null}
 */
export function nextSpeaker(threadId) {
  const t = S().threads[threadId];
  if (!t) return null;
  const last = S().sessions[t.lastSpeaker];
  if (t.kind === 'topic' || t.kind === 'side') {
    const handle = last?.handle ?? t.woke ?? t.pair?.split('|')[1] ?? S().sessions[t.members?.[0]]?.handle;
    const agent = sessionsOf(t.parentId).find((x) => x.handle === handle) ?? Object.values(S().personas).find((p) => p.handle === handle);
    return handle ? { handle, agent, last: !!last } : null;
  }
  const members = sessionsOf(threadId).filter((x) => !x.archived);
  const se = members.find((x) => x.id === t.lastSpeaker) ?? members[0];
  return se ? { handle: se.handle, agent: se, last: se === last } : null;
}

/** The agent a draft names without its @ (“critic: …”), when the message wouldn’t reach it: the UAT tester’s rule. */
const named = (threadId, draft) => unaddressed(draft, handles(), { lastSpeaker: nextSpeaker(threadId)?.handle ?? null })[0] ?? null;

/** What the address part of the hint depends on, so the composer repaints it only when that changes as you type. */
export const addressSig = (threadId, draft) => named(threadId, draft) ?? '';

/**
 * The hint’s first part: “Did you mean @critic?”, a button that adds the @, when the draft opens with an agent’s name
 * and “:” or “,”; then “Replying to @researcher”, in a room or a topic or side thread.
 * @param {string} threadId @param {string} draft @param {{ room: boolean, addAt: () => void }} opts
 */
export function addressLine(threadId, draft, { room, addAt }) {
  const next = nextSpeaker(threadId);
  const name = named(threadId, draft);
  return [
    name ? h('button.btn.sm.ghost.did-you-mean', { type: 'button', onclick: addAt }, 'Did you mean ', h('b', `@${name}`), '?') : null,
    room && next ? h('span', 'Replying to ', h('b', `@${next.handle}`), mockMarker(next.agent), next.last ? ' (last speaker)' : '') : null,
  ];
}
