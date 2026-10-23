// The room’s agent tree (#121), under each agent’s row in the Agents section: where the agent’s turn is when it’s in a
// side thread, each fork of it with its state and Stop, and the subagents at work in its turn (#73).

import { busy, client, hrefOf, sideSessionsOf, stopSession } from './client.mjs';
import { fill, h } from './dom.mjs';
import { openAsksEl } from './open-asks.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { navigate, say, toast } from './ui.mjs';

const S = () => client.state;

/**
 * The entries nested under an agent’s row (#121): its own turn when that’s in a side thread, and the forks of it in
 * this conversation’s side threads. A side-thread session that isn’t in the conversation shows where it is.
 */
export function treeOf(se) {
  const conv = S().threads[se.threadId];
  const out = [];
  const here = se.sideTurn && S().threads[se.sideTurn.threadId];
  if (here) out.push({ se, thread: here, by: se.sideTurn.by, fork: false });
  if (conv?.kind === 'side') out.push({ se, thread: conv, by: se.wokenBy ?? null, fork: false });
  else
    for (const f of sideSessionsOf(se.threadId).filter((x) => x.personaId === se.personaId && x.id !== se.id && !x.archived))
      out.push({ se: f, thread: S().threads[f.threadId], by: f.forkOf?.by ?? null, fork: true });
  return out;
}
export const treeSig = (list) => JSON.stringify(list.map((x) => [x.se.id, x.se.state, x.thread.id, x.thread.title, x.by, x.fork]));

/**
 * The subagents at work in an agent’s turn (#73), each after the one that started it, with how deep it is. One whose
 * parent isn’t listed (it ended, or the entry is from before #73) is at the top.
 */
export function subagentsOf(se) {
  const subs = Array.isArray(se.subagents) ? se.subagents : [];
  const ids = new Set(subs.map((x) => x.id).filter(Boolean));
  const parentOf = (x) => (x.parent && x.parent !== x.id && ids.has(x.parent) ? x.parent : null);
  /** @type {{ sub: any, depth: number }[]} */
  const out = [];
  const seen = new Set();
  const walk = (parent, depth) => {
    for (const sub of subs.filter((x) => parentOf(x) === parent && !seen.has(x))) {
      seen.add(sub);
      out.push({ sub, depth });
      if (sub.id) walk(sub.id, depth + 1);
    }
  };
  walk(null, 0);
  // Any a bad parent left out of the walk (a loop) is at the top, rather than gone.
  for (const sub of subs) if (!seen.has(sub)) out.push({ sub, depth: 0 });
  return out;
}

/**
 * What a subagent is doing now, in a line (#73): its latest narration in its own words, then its step if that changed
 * since; else its step, or what it’s thinking, labeled as thinking.
 * @param {{ said?: string, doing?: string, thinking?: boolean, since?: boolean }} sub
 */
export function subagentNow(sub) {
  const step = sub.doing ? (sub.thinking ? `Thinking: ${sub.doing}` : sub.doing) : '';
  if (sub.said) return `“${sub.said}”${sub.since && step ? ` · ${step}` : ''}`;
  return step || 'Starting';
}

/**
 * The subagents under an agent’s row, after its side-thread entries (#73). Each entry is kept and changed in place as
 * the subagent works, so its ring keeps turning and the entries beside it (and a focused Stop) aren’t rebuilt.
 * @param {HTMLElement} list @param {number} after how many entries come first @param {{ sub: any, depth: number }[]} subs
 */
export function paintSubagents(list, after, subs) {
  const keyOf = (/** @type {any} */ sub) => String(sub.id ?? sub.name);
  /** @type {Map<string, HTMLElement>} */
  const had = new Map(
    [...list.querySelectorAll(':scope > li.subagent')].map((li) => [/** @type {HTMLElement} */ (li).dataset.subagent ?? '', /** @type {HTMLElement} */ (li)]),
  );
  subs.forEach(({ sub, depth }, i) => {
    let li = had.get(keyOf(sub));
    had.delete(keyOf(sub));
    if (!li) {
      li = h(
        'li.agent-sub.subagent',
        { dataset: { subagent: keyOf(sub) } },
        h('span.ring-slot', { 'aria-hidden': 'true' }, h('pb-ring', { size: 'xs' })),
        h('span.name', h('span.sub-head'), h('span.sub-now')),
      );
    }
    li.dataset.depth = String(Math.min(depth, 3));
    // Set only when changed: a ring repaints on each attribute it’s given.
    const ring = li.querySelector('pb-ring');
    const ctx = String(Math.round(sub.ctx ?? 0));
    if (ring?.getAttribute('name') !== sub.name) ring?.setAttribute('name', sub.name);
    if (ring?.getAttribute('state') !== sub.state) ring?.setAttribute('state', sub.state);
    if (ring?.getAttribute('ctx') !== ctx) ring?.setAttribute('ctx', ctx);
    const asked = sub.asked && sub.asked !== sub.name ? sub.asked : null;
    fill(li.querySelector('.sub-head'), h('b', sub.name), ` · ${sub.bg ? 'subagent in the background' : 'subagent'}`, asked ? `: ${asked}` : '');
    const now = /** @type {HTMLElement} */ (li.querySelector('.sub-now'));
    if (now.textContent !== subagentNow(sub)) now.textContent = subagentNow(sub);
    now.className = `sub-now${sub.said ? ' said' : sub.thinking ? ' thinking' : ''}`;
    if (list.children[after + i] !== li) list.insertBefore(li, list.children[after + i] ?? null);
  });
  for (const li of had.values()) li.remove();
}

/** One nested entry: where it is (a link that opens the side thread), who woke it, its state, and its Stop. */
export function treeEntry({ se, thread, by, fork }) {
  const who = by === 'you' ? 'you' : by ? `@${by}` : null;
  // Who it’s talking with there: the other agent of the side thread’s pair, else who woke it.
  const partner = (thread.pair ?? '').split('|').find((x) => x && x !== se.handle) ?? (by && by !== 'you' ? by : null);
  // One line, state first, so it fits the sidebar: “Calling tools with @indexer”, or “Fork · calling tools with …”.
  const state = fork ? stateWord(se.state).toLowerCase() : stateWord(se.state);
  const line = `${fork ? 'Fork · ' : ''}${state}${partner ? ` with @${partner}` : ''}`;
  const where = `in the side thread “${thread.title}”${who ? `, woken by ${who}` : ''}`;
  const ring = fork ? ringFor(se, 'xs') : null;
  if (ring) ring.dataset.session = se.id;
  const stop = h(
    'button.btn.sm.ghost',
    {
      type: 'button',
      hidden: !busy(se),
      'aria-label': `Stop @${se.handle}${fork ? '’s fork' : ''} in ${thread.title}`,
      onclick: () =>
        stopSession(se).then(
          (r) => (r?.ask ? navigate(hrefOf(thread.id)) : say(`Stopping @${se.handle}${fork ? '’s fork' : ''}.`)),
          (e) => toast({ title: `Couldn’t stop @${se.handle}`, text: e.message, level: 'blocking' }),
        ),
    },
    'Stop',
  );
  return h(
    'li.agent-sub',
    { dataset: { session: se.id, fork: String(fork) } },
    h(
      'a.agent-sub-link',
      // The thread and who woke it are on hover and in its name; the link opens the thread.
      { href: hrefOf(thread.id), title: `${where[0].toUpperCase()}${where.slice(1)}`, 'aria-label': `${line}, ${where}` },
      ring ? h('span.ring-slot', { 'aria-hidden': 'true' }, ring) : null,
      // Under its persona’s row, so a fork needs no name.
      h('span.name', fork ? [h('b', 'Fork'), ` · ${line.slice('Fork · '.length)}`] : line),
    ),
    stop,
    fork ? h('div.agent-asks', openAsksEl(se, true)) : null,
  );
}
