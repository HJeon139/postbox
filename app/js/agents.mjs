// The agents in a conversation (#105): one row each in the sidebar with its ring, name, state, what it runs with and its
// open asks. Its name opens its persona sheet, the one place its settings change; what an agent does (Stop, Compact,
// Delete session) is a command addressed to it in the composer, `@handle /stop` (designs/rooms-at-scale.md, “Settings:
// one scope”).
//
// An agent whose turns run on a host (#120) says so in its row: the host, the connection in words, when
// Postbox last heard from it, and a turn there that’s stopping, lost or waiting to be resumed (app/js/remote.mjs).
//
// Under each row, the room’s agent tree (#121), in agent-tree.mjs: where the agent’s turn is when it’s in a side or
// topic thread, then the subagents at work in its turn (#73), its only children (#228), each under the one that
// started it, with what it was asked and what it’s doing now, a line each, without hover.

import { chipEffort, chipModel } from '/shared/agent-facts.mjs';
import { factsOf, mockMarker } from './agent-facts.mjs';
import { everyMinute, hostBadge } from './agent-host.mjs';
import { agentQueueButton } from './agent-queue.mjs';
import { paintTree, subagentToggle } from './agent-tree.mjs';
import { client, itemsOf, sessionsOf } from './client.mjs';
import { fill, h, syncList } from './dom.mjs';
import { openAsksEl } from './open-asks.mjs';
import { hostLine, hostOf, turnLine } from './remote.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { openSettings } from './sheets.mjs';

export { subagentNow } from './agent-tree.mjs';

const S = () => client.state;

// ── The section ─────────────────────────────────────────────────────────────────────────

/**
 * The Agents section for a conversation, in the sidebar: the conversation’s pool, one row per agent, since each has
 * one session there (#228). It keeps itself up to date as agents join, leave, change state or change what they run with.
 * @param {string} threadId
 */
export function agentsSection(threadId) {
  const headId = `agents-head-${threadId}`;
  const list = h('ul.agent-rows', { 'aria-labelledby': headId });
  const el = h('section.agents-sec', h('div.rail-sec', h('h2.label', { id: headId }, 'Agents')), list);
  const paint = () => {
    const ses = sessionsOf(threadId).filter((x) => !x.archived);
    el.hidden = !ses.length;
    syncList(
      list,
      ses,
      (se) => se.id,
      (se) => agentRow(se),
      (n, se) => paintRow(n, se),
    );
  };
  paint();
  const off = client.on((ch) => {
    if (ch.type === 'session' && ch.data.threadId !== threadId && S().threads[ch.data.threadId]?.parentId !== threadId) return;
    if (['session', 'thread', 'persona', 'load', 'remove', 'host', 'host.status'].includes(ch.type)) paint();
  });
  return { el, destroy: everyMinute(el, paint, off) };
}

/**
 * Who is in a topic thread, in one line for its panel (#228): the agent it started with, and the ones that answered
 * there. Each answers from its one session in the conversation, so the thread has no list of agents of its own.
 * @param {string} threadId
 */
export function inThreadLine(threadId) {
  const el = h('p.small.dim');
  const paint = () => {
    const said = itemsOf(threadId).filter((i) => i.kind === 'agent' && i.handle);
    const names = [...new Set([S().threads[threadId]?.woke, ...said.map((i) => i.handle)].filter(Boolean))];
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    const text = list ? `${list} ${names.length > 1 ? 'are' : 'is'} in this thread.` : 'No agent is in this thread yet. @-mention one to bring it in.';
    if (el.textContent !== text) el.textContent = text;
  };
  paint();
  const off = client.on((ch) => {
    if (['item.add', 'thread', 'load'].includes(ch.type)) paint();
  });
  return { el, destroy: off };
}

/**
 * One agent’s row: its ring, which goes to what it needs while it needs you (#320, needs-nav.mjs), then a button with its
 * name that opens its persona sheet, always, and its open asks under it.
 */
function agentRow(se) {
  const button = h('button.agent-btn', {
    type: 'button',
    id: `agent-row-${se.id}`,
    'aria-haspopup': 'dialog',
    onclick: () => openSettings('personas', se.personaId),
  });
  // Its ring is made once and kept, so its animation keeps running; the words beside it repaint.
  const ring = ringFor(se, 'sm');
  ring.dataset.session = se.id;
  button.append(h('span.name'));
  const n = h(
    'li.agent-row',
    h(
      'div.agent-line',
      h('span.ring-slot', ring),
      button,
      subagentToggle(se.id, () => paintRow(n, S().sessions[se.id] ?? se)),
      agentQueueButton(se),
    ),
    h('div.agent-asks', openAsksEl(se)),
    h('ul.agent-subs', { id: `agent-subs-${se.id}`, 'aria-label': `Where ${se.handle} is at work, and its subagents` }),
  );
  paintRow(n, se, true);
  return n;
}

function paintRow(n, se, fresh = false) {
  const f = factsOf(se);
  const runs = f.mock ? '' : `${chipModel(f)} · ${chipEffort(f)}`;
  const joined = joinedWhy(se);
  // Where it runs, for an agent on a host, and how its turn there stands when that needs saying.
  const where = [hostLine(se), hostOf(se)?.short];
  const there = turnLine(se);
  const sig = JSON.stringify([se.handle, f.mock, se.state, runs, joined, where, there]);
  paintTree(n, se, fresh);
  if (!fresh && n.dataset.sig === sig) return;
  n.dataset.sig = sig;
  fill(
    n.querySelector('.agent-btn .name'),
    h('span', h('b', se.handle), mockMarker(se), h('span.agent-state', ` · ${stateWord(se.state).toLowerCase()}`)),
    runs ? h('span.sub', runs) : null,
    hostBadge(se),
    there ? h('span.sub.host-turn', there) : null,
    joined ? h('span.sub', joined) : null,
  );
}

/**
 * Why an agent the person never added is in the conversation: another agent woke it, or they @-mentioned it, in a side
 * thread, and it joined to answer (#110). null for one the person added.
 */
export function joinedWhy(se) {
  if (!se.joinedBy) return null;
  return se.joinedBy === 'you' ? 'Joined when you @-mentioned it in a side thread' : `Joined when ${se.joinedBy} woke it`;
}
