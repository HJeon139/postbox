// The room’s agent tree (#121), under each agent’s row in the Agents section: where the agent’s turn is when it’s in a
// side or topic thread, and the subagents at work in its turn (#73), which are its only children: there are no forks
// (#228).

import { api, busy, client, hrefOf, stopSession } from './client.mjs';
import { fill, h } from './dom.mjs';
import { stateWord } from './ring.mjs';
import { navigate, say, toast } from './ui.mjs';

const S = () => client.state;

/** The entry nested under an agent’s row before its subagents (#121): its own turn, when that’s in a side or topic thread. */
export function treeOf(se) {
  const here = se.sideTurn && S().threads[se.sideTurn.threadId];
  return here ? [{ se, thread: here, by: se.sideTurn.by }] : [];
}
export const treeSig = (list) => JSON.stringify(list.map((x) => [x.se.id, x.se.state, x.thread.id, x.thread.title, x.by]));

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
 * The subagents under an agent’s row, after its side-thread entries (#73), each with End (#229). Each entry is kept and
 * changed in place as the subagent works, so its ring keeps turning and the entries beside it (and a focused End or
 * Stop) aren’t rebuilt.
 * @param {HTMLElement} list @param {number} after how many entries come first @param {{ sub: any, depth: number }[]} subs
 * @param {any} se  the agent they work for
 */
export function paintSubagents(list, after, subs, se) {
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
        h('button.btn.sm.ghost.sub-end', { type: 'button', onclick: () => endSubagent(se.id, /** @type {HTMLElement} */ (li)) }, 'End'),
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
    // Ended by the person: it reads “ending” until it or the turn ends, since only its agent can stop it (#229).
    const ending = !!sub.id && (S().sessions[se.id]?.endingSubagents ?? []).includes(sub.id);
    const line = ending ? `Ending: @${se.handle} was told to stop it` : subagentNow(sub);
    if (now.textContent !== line) now.textContent = line;
    now.className = `sub-now${ending ? '' : sub.said ? ' said' : sub.thinking ? ' thinking' : ''}`;
    const end = /** @type {HTMLButtonElement} */ (li.querySelector('.sub-end'));
    end.hidden = !sub.id || ending;
    end.setAttribute('aria-label', `End @${se.handle}’s subagent ‘${asked ?? sub.name}’`);
    li.dataset.subId = sub.id ?? '';
    if (list.children[after + i] !== li) list.insertBefore(li, list.children[after + i] ?? null);
  });
  for (const li of had.values()) li.remove();
}

/**
 * End on a subagent’s row (#229): its agent is told to stop it and not use its result. Focus moves to the next
 * subagent’s End, else the agent’s row, since this one now reads “ending”.
 * @param {string} sessionId @param {HTMLElement} li
 */
function endSubagent(sessionId, li) {
  const next = /** @type {HTMLElement | null} */ (li.nextElementSibling?.querySelector('.sub-end:not([hidden])') ?? null);
  const row = /** @type {HTMLElement | null} */ (li.closest('li.agent-row')?.querySelector('.agent-btn') ?? null);
  const name = li.querySelector('.sub-head b')?.textContent ?? 'the subagent';
  // The next row can go meanwhile (its subagent ended): then focus goes to the agent’s row.
  const move = () => /** @type {HTMLElement | null} */ (next?.isConnected ? next : row)?.focus();
  api(`/api/sessions/${sessionId}/stop`, { subagent: li.dataset.subId }).then(
    () => {
      move();
      say(`Told the agent to stop ${name} and not use its result.`);
    },
    // It finished first (409): nothing to end, and nothing wrong. Anything else did go wrong.
    (e) => {
      move();
      if (e.status === 409) say(`${name} had already finished.`);
      else toast({ title: `Couldn’t end ${name}`, text: e.message, level: 'blocking' });
    },
  );
}

/** One nested entry: where it is (a link that opens the side thread), who woke it, its state, and its Stop. */
export function treeEntry({ se, thread, by }) {
  const who = by === 'you' ? 'you' : by ? `@${by}` : null;
  // Who it’s talking with there: the other agent of the side thread’s pair, else who woke it.
  const partner = (thread.pair ?? '').split('|').find((x) => x && x !== se.handle) ?? (by && by !== 'you' ? by : null);
  // One line, state first, so it fits the sidebar: “Calling tools with @indexer”.
  const line = `${stateWord(se.state)}${partner ? ` with @${partner}` : ''}`;
  const where = `in the ${thread.kind === 'topic' ? 'thread' : 'side thread'} “${thread.title}”${who ? `, woken by ${who}` : ''}`;
  const stop = h(
    'button.btn.sm.ghost',
    {
      type: 'button',
      hidden: !busy(se),
      'aria-label': `Stop @${se.handle} in ${thread.title}`,
      onclick: () =>
        stopSession(se).then(
          (r) => (r?.ask ? navigate(hrefOf(thread.id)) : say(`Stopping @${se.handle}.`)),
          (e) => toast({ title: `Couldn’t stop @${se.handle}`, text: e.message, level: 'blocking' }),
        ),
    },
    'Stop',
  );
  return h(
    'li.agent-sub',
    { dataset: { session: se.id } },
    h(
      'a.agent-sub-link',
      // The thread and who woke it are on hover and in its name; the link opens the thread.
      { href: hrefOf(thread.id), title: `${where[0].toUpperCase()}${where.slice(1)}`, 'aria-label': `${line}, ${where}` },
      h('span.name', line),
    ),
    stop,
  );
}
