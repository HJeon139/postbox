// The agents in a conversation or a topic thread (#105): one row each in the sidebar (or the thread panel) with its
// ring, name, state, what it runs with and its open asks, and a quick panel behind each row and each ring in the
// top bar. The panel changes the model, effort, permission mode and tools in two clicks, without a command, and
// says the scope of each: model and effort are this conversation’s, mode and tools the persona’s, everywhere.
//
// Under each row, the room’s agent tree (#121): where the agent’s turn is when it’s in a side thread, and each fork of
// it that answered there while it was busy (#110), with who woke it, its state and a Stop. A persona with two
// sessions shows two entries. Then the subagents at work in its turn (#73), each under the one that started it, with
// what it was asked and what it’s doing now, a line each, without hover.

import { BACKEND_NAMES, chipEffort, chipModel, shortModel } from '/shared/agent-facts.mjs';
import { ASKING } from '/shared/catalog.mjs';
import { factsOf, isMock, mockMarker } from './agent-facts.mjs';
import { api, busy, client, hrefOf, itemsOf, sessionsOf, sideSessionsOf, stopSession } from './client.mjs';
import { fill, h, plural, syncList } from './dom.mjs';
import { MODES, openPermissions } from './permissions.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { capsOf, EFFORT_NAMES, modeHelp, modelsFor, openSettings } from './sheets.mjs';
import { keepFocus, navigate, openDialog, say, toast } from './ui.mjs';

const S = () => client.state;

// ── Open blocks ─────────────────────────────────────────────────────────────────────────
// Asking blocks you left open from an earlier turn don’t make their agent need you. They show quietly
// beside it instead, as “1 open review”, and stay open so you can still answer them (#69).

const ASK_NOUNS = { choice: ['choice', 'choices'], form: ['form', 'forms'], confirm: ['confirmation', 'confirmations'], review: ['review', 'reviews'] };
/** @returns {{ text: string, itemId: string } | null} */
export function openAsks(se) {
  // Its own thread’s, and those it showed while answering in a side thread of it (#110).
  const threads = [
    se.threadId,
    ...Object.values(S().threads)
      .filter((t) => t.kind === 'side' && t.parentId === se.threadId)
      .map((t) => t.id),
  ];
  const open = threads
    .flatMap(itemsOf)
    .filter((it) => it.kind === 'block' && it.sessionId === se.id && it.valid && ASKING.has(it.block.type) && !it.answered && it.id !== se.needs?.itemId);
  if (!open.length) return null;
  const types = new Set(open.map((it) => it.block.type));
  const [one, many] = types.size === 1 ? ASK_NOUNS[open[0].block.type] : ['request', 'requests'];
  return { text: plural(open.length, `open ${one}`, `open ${many}`), itemId: open[0].id };
}
/**
 * “1 open review” for an agent: quiet text on its overview card, or a button in its row that goes to the block.
 * @param {any} se @param {boolean} [button] @param {() => void} [before] what to do first, such as close the panel it’s in
 */
export function openAsksEl(se, button = false, before = undefined) {
  const el = button
    ? h('button.btn.sm.ghost', {
        type: 'button',
        dataset: { openAsks: se.id },
        onclick: () => {
          before?.();
          goToItem(el.dataset.item);
        },
      })
    : h('span.small.dim', { dataset: { openAsks: se.id } });
  paintOpenAsks(el);
  return el;
}
function paintOpenAsks(el) {
  const se = S().sessions[el.dataset.openAsks];
  const ask = se ? openAsks(se) : null;
  el.hidden = !ask;
  if (el.textContent !== (ask?.text ?? '')) el.textContent = ask?.text ?? '';
  if (ask) el.dataset.item = ask.itemId;
  if (ask && el.tagName === 'BUTTON') el.setAttribute('aria-label', `${ask.text} from @${se.handle}: go to it`);
}
client.on((ch) => {
  if (['session', 'item.add', 'item.patch', 'load'].includes(ch.type)) for (const el of document.querySelectorAll('[data-open-asks]')) paintOpenAsks(el);
});

/** Scrolls to an item in the transcript or the thread panel, and focuses what can be answered in it. */
function goToItem(itemId) {
  const node = document.querySelector(`[data-key="${CSS.escape(itemId ?? '')}"]`);
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  (node.querySelector('button:not([disabled]), input, textarea, select') ?? node).focus();
}

// ── The section ─────────────────────────────────────────────────────────────────────────

/**
 * Which agents a conversation or topic thread lists: the ones in it, not archived, then any side-thread session whose
 * persona isn’t one of them (from before #110, each wake started one).
 */
const agentsIn = (threadId) => {
  const own = sessionsOf(threadId).filter((x) => !x.archived);
  const personas = new Set(own.map((x) => x.personaId));
  const strays = sideSessionsOf(threadId).filter((x) => !x.archived && !personas.has(x.personaId) && !x.forkOf?.busy);
  return [...own, ...strays];
};

/**
 * The Agents section for a conversation (the sidebar) or a topic thread (its panel): a heading, then a row per
 * agent. It keeps itself up to date as agents join, leave, change state or change what they run with.
 * @param {string} threadId @param {{ label?: string }} [opts]
 */
export function agentsSection(threadId, { label = 'Agents' } = {}) {
  const headId = `agents-head-${threadId}`;
  const list = h('ul.agent-rows', { 'aria-labelledby': headId });
  const el = h('section.agents-sec', h('div.rail-sec', h('h2.label', { id: headId }, label)), list);
  const paint = () => {
    const ses = agentsIn(threadId);
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
    if (['session', 'thread', 'persona', 'load', 'remove'].includes(ch.type)) paint();
  });
  return { el, destroy: off };
}

/**
 * The entries nested under an agent’s row (#121): its own turn when that’s in a side thread, and the forks of it in
 * this conversation’s side threads. A side-thread session that isn’t in the conversation shows where it is.
 */
function treeOf(se) {
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
const treeSig = (list) => JSON.stringify(list.map((x) => [x.se.id, x.se.state, x.thread.id, x.thread.title, x.by, x.fork]));

/**
 * The subagents at work in an agent’s turn (#73), each after the one that started it, with how deep it is. One whose
 * parent isn’t listed (it ended, or the entry is from before #73) is at the top.
 */
function subagentsOf(se) {
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
function paintSubagents(list, after, subs) {
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
function treeEntry({ se, thread, by, fork }) {
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

/** One agent’s row: a button that opens its quick panel, and its open asks under it. */
function agentRow(se) {
  const button = h('button.agent-btn', {
    type: 'button',
    id: `agent-row-${se.id}`,
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    onclick: () => openAgentPanel(se.id, button),
  });
  // Its ring is made once and kept, so its animation keeps running; the words beside it repaint.
  const ring = ringFor(se, 'sm');
  ring.dataset.session = se.id;
  button.append(h('span.ring-slot', { 'aria-hidden': 'true' }, ring), h('span.name'));
  const n = h(
    'li.agent-row',
    button,
    h('div.agent-asks', openAsksEl(se, true)),
    h('ul.agent-subs', { 'aria-label': `@${se.handle}’s sessions in side threads, and its subagents` }),
  );
  paintRow(n, se, true);
  return n;
}

function paintRow(n, se, fresh = false) {
  const f = factsOf(se);
  const runs = f.mock ? '' : `${chipModel(f)} · ${chipEffort(f)}`;
  const joined = joinedWhy(se);
  const sig = JSON.stringify([se.handle, f.mock, se.state, runs, joined]);
  ringFor(se, 'sm', n.querySelector('.agent-btn pb-ring'));
  const tree = treeOf(se);
  const subagents = subagentsOf(se);
  const subs = n.querySelector('.agent-subs');
  subs.hidden = !tree.length && !subagents.length;
  if (fresh || subs.dataset.sig !== treeSig(tree)) {
    subs.dataset.sig = treeSig(tree);
    subs.replaceChildren(...tree.map(treeEntry), ...subs.querySelectorAll(':scope > li.subagent'));
  }
  paintSubagents(subs, tree.length, subagents);
  if (!fresh && n.dataset.sig === sig) return;
  n.dataset.sig = sig;
  fill(
    n.querySelector('.agent-btn .name'),
    h('span', h('b', `@${se.handle}`), mockMarker(se), h('span.agent-state', ` · ${stateWord(se.state).toLowerCase()}`)),
    runs ? h('span.sub', runs) : null,
    joined ? h('span.sub', joined) : null,
  );
}

/**
 * Why an agent the person never added is in the conversation: another agent woke it, or they @-mentioned it, in a side
 * thread, and it joined to answer (#110). null for one the person added.
 */
export function joinedWhy(se) {
  if (!se.joinedBy) return null;
  return se.joinedBy === 'you' ? 'Joined when you @-mentioned it in a side thread' : `Joined when @${se.joinedBy} woke it`;
}

// ── The quick panel ─────────────────────────────────────────────────────────────────────

// Each tool switch says what turning it off means (#104): the agent can’t tell you, and the panel is where you look.
const QUICK_TOOLS = [
  ['shell', 'Shell', 'Off: it can’t run commands. It can still read and search files.'],
  ['web.fetch', 'Web', 'Off: it can’t fetch pages or search the web.'],
  ['agents.outside', 'Agents outside Postbox', 'Off: it can’t message, schedule or start agents outside Postbox.'],
];

/**
 * Opens an agent’s quick panel, beside the row or ring it came from (a full sheet in a narrow window).
 * @param {string} sessionId @param {HTMLElement | null} [from]
 */
export function openAgentPanel(sessionId, from = null) {
  const first = S().sessions[sessionId];
  if (!first) return;
  const t = S().threads[first.threadId];
  const where = t?.kind === 'topic' ? 'this thread' : t?.kind === 'side' ? 'this side thread' : 'this conversation';
  let status = '';
  /** @type {{ close: () => void, dialog: HTMLElement } | null} */
  let dlg = null;
  const body = h('div.qp');
  const title = h('span');
  const sub = h('span');
  const done = (text) => {
    status = text;
    say(text);
    paint();
  };
  const failed = (e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' });

  const paint = () => {
    const se = S().sessions[sessionId];
    if (!se || se.archived) {
      dlg?.close();
      return;
    }
    const p = S().personas[se.personaId] ?? {};
    const f = factsOf(se);
    const mock = isMock(se);
    fill(title, `@${se.handle}`, mockMarker(se));
    fill(sub, `${stateWord(se.state)} · ${se.ctx ?? 0}% of context used · ${mock ? BACKEND_NAMES.mock : (BACKEND_NAMES[f.backend] ?? f.backend)}`);
    keepFocus(body, () =>
      fill(
        body,
        h(
          'div.qp-asks',
          openAsksEl(se, true, () => dlg?.close()),
        ),
        // This conversation’s: the session’s snapshot, as /model and /effort set it.
        mock
          ? h('p.help', 'A mock agent runs scripted replies, so it has no model, effort or permission mode to change.')
          : section(
              `In ${where}`,
              `From its next turn, as /model and /effort set them.`,
              choice(
                'Model',
                where,
                [...new Set([...modelsFor(f.backend), f.setModel])].map((m) => [m, shortModel(m)]),
                f.setModel,
                (id, name) =>
                  api(`/api/sessions/${se.id}/run`, { model: id }).then(
                    (r) => done(`Model: ${name} for @${se.handle} in ${where}, ${r.now ? 'from now: its running turn changed too' : 'from its next turn'}.`),
                    failed,
                  ),
              ),
              choice(
                'Effort',
                where,
                (client.config.effortLevels ?? Object.keys(EFFORT_NAMES)).map((l) => [l, EFFORT_NAMES[l] ?? l]),
                f.setEffort,
                (id, name) =>
                  api(`/api/sessions/${se.id}/run`, { effort: id }).then(
                    (r) =>
                      done(
                        `Effort: ${name.toLowerCase()} for @${se.handle} in ${where}, ${r.now ? 'from now: its running turn changed too' : 'from its next turn'}.`,
                      ),
                    failed,
                  ),
              ),
            ),
        // The persona’s, in every conversation it’s in.
        section(
          `For @${se.handle} everywhere`,
          'Its persona: every conversation it’s in, from their next turns.',
          mock ? null : modeChoice(se, p, done, failed),
          h(
            'div.field',
            h('span.label', 'Tools'),
            h(
              'div.qp-tools',
              QUICK_TOOLS.filter(([id]) => (client.config.knownTools ?? []).some(([k]) => k === id)).map(([id, name, off]) =>
                toolSwitch(se, p, id, name, off, done, failed),
              ),
            ),
          ),
          h(
            'div.row-flex.wrap',
            !mock && capsOf(f.backend).permissions !== 'none'
              ? h(
                  'button.btn.sm',
                  { type: 'button', onclick: () => handOff(() => openPermissions({ threadId: se.threadId, sessionId: se.id })) },
                  'Rules, folders and MCP…',
                )
              : null,
            h('button.btn.sm', { type: 'button', onclick: () => handOff(() => openSettings('personas', se.personaId)) }, 'Edit persona…'),
          ),
        ),
        // Announced once by say(); a live region here would be read again on every repaint.
        status ? h('p.small.perm-status', status) : null,
        h(
          'div.qp-actions',
          h(
            'button.btn.sm',
            {
              type: 'button',
              // Not while it’s already stopping (#126): it says so in the row and the panel’s line, and Stop is pressed once.
              disabled: !busy(se),
              onclick: () =>
                stopSession(se).then(
                  // With background jobs running, Stop asks in the conversation whether to stop them too (#129): go there.
                  (r) => (r?.ask ? handOff(() => navigate(hrefOf(se.threadId))) : done(`Stopping @${se.handle}.`)),
                  failed,
                ),
            },
            'Stop',
          ),
          mock
            ? null
            : h(
                'button.btn.sm',
                {
                  type: 'button',
                  disabled: busy(se),
                  onclick: () =>
                    api(`/api/threads/${se.threadId}/agent-command`, { sessionId: se.id, text: '/compact' }).then(
                      () => handOff(() => say(`@${se.handle} is compacting its context.`)),
                      failed,
                    ),
                },
                'Compact',
              ),
          h(
            'button.btn.sm',
            {
              type: 'button',
              onclick: () =>
                api(`/api/sessions/${se.id}/archive`, {}).then(
                  () =>
                    handOff(() => {
                      toast({ title: `Archived @${se.handle}’s session`, action: { label: 'Restore', run: () => api(`/api/sessions/${se.id}/restore`, {}) } });
                      // Its row has gone, so focus has nowhere to go back to: the composer, as after acting in a block.
                      if (document.activeElement === document.body) document.getElementById('composer-input')?.focus();
                    }),
                  failed,
                ),
            },
            'Archive',
          ),
        ),
      ),
    );
  };
  /** Closes the panel (focus goes back to its row or ring), then does what the button leads to. */
  const handOff = (next) => {
    dlg?.close();
    next();
  };
  paint();
  dlg = openDialog({
    title,
    sub,
    body: [body],
    size: 'quick',
    anchor: from,
    onClose: () => {
      off();
      from?.setAttribute('aria-expanded', 'false');
    },
    // The model’s choice, or for a mock agent its first tool.
    initialFocus: () => body.querySelector('[role=radiogroup] [aria-checked="true"]') ?? body.querySelector('[role=switch]'),
  });
  const off = client.on((ch) => {
    const mine = ch.type === 'session' ? ch.data.id === sessionId : ['item.add', 'item.patch'].includes(ch.type) ? ch.data?.threadId === first.threadId : true;
    if (mine && ['session', 'persona', 'load', 'item.add', 'item.patch'].includes(ch.type)) paint();
  });
  from?.setAttribute('aria-expanded', 'true');
}

/** A group of settings with one scope, said in its heading. */
function section(heading, help, ...fields) {
  const id = `qp-${Math.random().toString(36).slice(2, 8)}`;
  return h('section.qp-sec', { 'aria-labelledby': id }, h('h3.qp-head', { id }, heading), h('p.help', help), ...fields);
}

/**
 * Segmented choices, named with their scope so a screen reader hears it on each: “Model, in this conversation”.
 * One Tab stop per group: the arrow keys move within it, and Enter or Space picks, since each pick changes the agent.
 */
function choice(label, where, list, value, onPick) {
  const move = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const radios = [...e.currentTarget.querySelectorAll('[role=radio]')];
    radios[(radios.indexOf(document.activeElement) + step + radios.length) % radios.length]?.focus();
  };
  return h(
    'div.field',
    h('span.label', label),
    h(
      'div.seg.seg-wrap',
      { role: 'radiogroup', 'aria-label': `${label}, in ${where}`, onkeydown: move },
      list.map(([id, name]) =>
        h(
          'button',
          { type: 'button', role: 'radio', 'aria-checked': String(id === value), tabindex: id === value ? '0' : '-1', onclick: () => onPick(id, name) },
          name,
        ),
      ),
    ),
  );
}

function modeChoice(se, p, done, failed) {
  const value = p.permissionMode ?? 'auto';
  return [
    choice(
      'Permission mode',
      `every conversation @${se.handle} is in`,
      MODES.map(([id, name]) => [id, name]),
      value,
      (id, name) =>
        api('/api/permissions/mode', { personaId: se.personaId, mode: id }).then(
          (r) =>
            done(
              `Permission mode: ${name} for @${se.handle} in every conversation, ${r.now.includes(se.handle) ? 'from now: its running turn changed too' : 'from their next turns'}.`,
            ),
          failed,
        ),
    ),
    // In the backend’s own words where it reads the modes differently (Kiro, Codex), as the persona sheet says it.
    h('span.help', modeHelp(p.backend, MODES.find(([id]) => id === value) ?? MODES[0])),
  ];
}

/** A tool as a switch, on the persona: on means not denied; the permission mode still decides (TOOL_RULES). */
function toolSwitch(se, p, id, name, off, done, failed) {
  const on = (p.tools ?? []).includes(id);
  const helpId = `qp-tool-${id.replace(/\W/g, '-')}`;
  return h(
    'div.qp-tool',
    h(
      'button.qp-switch',
      {
        type: 'button',
        role: 'switch',
        'aria-checked': String(on),
        'aria-label': `${name}, for @${se.handle} everywhere`,
        'aria-describedby': helpId,
        onclick: () => {
          // From the persona as it is now, not as it was when the panel painted: another switch may have changed it.
          const now = S().personas[se.personaId]?.tools ?? [];
          const was = now.includes(id);
          const tools = was ? now.filter((x) => x !== id) : [...now, id];
          api(`/api/personas/${se.personaId}`, { tools }, 'PATCH').then(
            () => done(`${name}: ${was ? 'off' : 'on'} for @${se.handle} in every conversation, from their next turns.`),
            failed,
          );
        },
      },
      h('span.track', { 'aria-hidden': 'true' }),
      h('span', name),
      h('span.dim.small', { 'aria-hidden': 'true' }, on ? 'On' : 'Off'),
    ),
    h('span.help', { id: helpId }, off),
  );
}
