// Who a message from the composer goes to, as sendMessage decides it (server/runtime.mjs), for the composer’s hint: a
// message wakes the agents it @-mentions, and only them (#107); one that @-mentions no one goes to the next speaker,
// and one that names an agent without its @ may not reach it (#134).

import { parseMentions, unaddressed } from '/shared/text.mjs';
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
export const addressSig = (threadId, draft) => JSON.stringify([parseMentions(draft, handles()), named(threadId, draft)]);

/**
 * The hint’s first part. A draft that @-mentions agents: “Wakes @critic, not @researcher (last speaker)”, since the
 * agent it would otherwise go to isn’t woken, and reads it at its next turn (#107). Otherwise “Did you mean @critic?”,
 * a button that adds the @, when the draft opens with an agent’s name and “:” or “,”; then “Replying to @researcher”,
 * in a room or a topic or side thread.
 * @param {string} threadId @param {string} draft @param {{ room: boolean, addAt: () => void }} opts
 */
export function addressLine(threadId, draft, { room, addAt }) {
  const next = nextSpeaker(threadId);
  const wakes = parseMentions(draft, handles());
  if (wakes.length) {
    const not = next && !wakes.includes(next.handle) ? [', not ', h('b', `@${next.handle}`), next.last ? ' (last speaker)' : ''] : [];
    return [
      h(
        'span.wakes',
        'Wakes ',
        wakes.flatMap((x, i) => [i ? ', ' : '', h('b', `@${x}`)]),
        ...not,
      ),
    ];
  }
  const name = named(threadId, draft);
  return [
    name ? h('button.btn.sm.ghost.did-you-mean', { type: 'button', onclick: addAt }, 'Did you mean ', h('b', `@${name}`), '?') : null,
    room && next ? h('span', 'Replying to ', h('b', `@${next.handle}`), mockMarker(next.agent), next.last ? ' (last speaker)' : '') : null,
  ];
}

/**
 * What Enter runs and for whom: a skill picked from the / menu (#67), or a command aimed at one agent with
 * `@handle /name` (#405); or, when that agent offers no such command or isn’t here, that the line goes as a message.
 * @param {any} r  resolveCommand’s answer (shared/slash-line.mjs), or { name, hint, named } for a picked skill
 * @param {string} threadId
 */
export function commandHint(r, threadId) {
  if (r?.missing === 'agent') {
    const next = nextSpeaker(threadId);
    return h('span', 'No agent ', h('b', `@${r.handle}`), ' here, so Enter sends this', next ? [' to ', h('b', `@${next.handle}`)] : null, ' as a message');
  }
  if (!r?.named) return null;
  const who = h('b', `@${r.named.handle}`);
  if (r.missing) return h('span', who, ' has no ', h('span.mono', `/${r.name}`), ' skill or command, so Enter sends this to it as a message');
  const hint = r.hint ? [' ', h('span.mono.dim', r.hint)] : null;
  return h('span', 'Enter runs ', h('span.mono', `/${r.name}`), hint, r.own ? ' for ' : ' as ', who, r.own ? '' : '’s turn');
}
