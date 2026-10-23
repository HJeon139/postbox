// The shell: top bar, rail (conversations and rooms with rings), the phone ring strip, and the overview —
// one column per live session, with quick answers, tool calls, subagents, agent messages and stats.

import { chipEffort, chipModel, factsText, installNote } from '/shared/agent-facts.mjs';
import { ASKING } from '/shared/catalog.mjs';
import { renderMarkdown, toPlainText } from '/shared/markdown.mjs';
import { factsOf, isMock, mockMarker } from './agent-facts.mjs';
import { api, busy, client, hrefOf, itemsOf, liveSessions, needsYou, sessionsOf, threadState, threadsOf, topicsOf } from './client.mjs';
import { ago, fill, h, icon, plural, syncList, timeOf } from './dom.mjs';
import { openPermissions } from './permissions.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { confirmDelete, confirmDeleteThread, openNewAgent, openNewThread, openPalette, openRename, openSettings } from './sheets.mjs';
import { navigate, openMenu, route, toast, undoToast } from './ui.mjs';

const S = () => client.state;

/**
 * The top bar: Postbox, then Overview and each project as tabs, the open conversation’s title and who’s in
 * it, and the global actions. On a phone the tabs fold into one menu button.
 */
export function topbar({ title = '', threadId = null, projectId = null, work = false }) {
  const t = threadId ? S().threads[threadId] : null;
  const pid = t?.projectId ?? projectId;
  const project = pid ? S().projects[pid] : null;
  const present = t
    ? h(
        'div.present',
        sessionsOf(threadId)
          .filter((x) => !x.archived)
          .map((se) => {
            const r = ringFor(se, 'xs');
            r.dataset.session = se.id;
            // Ring, name, what it runs with, then its state. #73’s “subagents running” goes after the state.
            return h(
              'span.who-chip',
              r,
              h('b', `@${se.handle}`),
              chipFacts(se),
              h('span.who-state', { dataset: { session: se.id } }, `· ${stateWord(se.state).toLowerCase()}`),
              openAsksEl(se, true),
            );
          }),
      )
    : null;
  const n = needsYou().length;
  const needsIn = (id) => needsYou().filter((se) => S().threads[se.threadId]?.projectId === id).length;
  const projects = Object.values(S().projects);
  // The Postbox mark opens the places menu: the overview and every project, from anywhere.
  const places = (e) =>
    openMenu(
      e.currentTarget,
      [
        { label: 'Overview', desc: n ? `${n} need you` : 'Every live session', icon: pid ? 'agent' : 'check', run: () => navigate('#/') },
        'hr',
        { heading: 'Projects' },
        ...projects.map((p) => ({
          label: p.name,
          desc: needsIn(p.id) ? `${needsIn(p.id)} need you` : (p.folder ?? '').replace(/^\/Users\/[^/]+/, '~'),
          icon: p.id === pid ? 'check' : 'folder',
          run: () => navigate(`#/p/${p.id}`),
        })),
        'hr',
        { label: 'New project…', icon: 'plus', run: () => openSettings('projects') },
      ],
      { label: 'Go to' },
    );
  // The rail can be hidden, in any view that has one; the choice is remembered.
  const railToggle =
    t || pid
      ? h(
          'button.btn.icon.sm.ghost.hide-sm',
          {
            type: 'button',
            id: 'rail-toggle',
            'aria-label': railHidden() ? 'Show the sidebar' : 'Hide the sidebar',
            'aria-pressed': String(!railHidden()),
            'aria-keyshortcuts': 'Meta+Backslash',
            onclick: toggleRail,
          },
          icon('sidebar'),
        )
      : null;
  const up = title ? '.up' : '';
  const bar = h(
    'header.topbar',
    railToggle,
    h(
      'button.brand',
      {
        type: 'button',
        id: 'places-button',
        'aria-haspopup': 'menu',
        'aria-label': `Postbox: go to the overview or a project${n ? ` (${n} need you)` : ''}`,
        onclick: places,
      },
      h('span.mark', { 'aria-hidden': 'true' }),
      h('span.hide-sm', 'Postbox'),
      icon('down', 'i-sm'),
    ),
    h(
      'span.crumbs',
      // The crumb above the title (.up) is the first thing the top bar drops for room after the chips’ words (#72).
      project
        ? [icon('right', `i-sm${up}`), h(`a.crumb${up}`, { href: `#/p/${project.id}` }, project.name)]
        : [icon('right', `i-sm${up}`), h(t || title ? `a.crumb${up}` : 'span.title', t || title ? { href: '#/' } : {}, 'Overview')],
      title ? [icon('right', 'i-sm'), h('span.title', title)] : null,
    ),
    // A conversation has two views: its transcript, and its Work (#132).
    t
      ? h(
          'nav.conv-tabs',
          { 'aria-label': 'Views of this conversation' },
          h('a', { href: `#/t/${t.id}`, 'aria-current': work ? null : 'page' }, 'Conversation'),
          h('a', { href: `#/t/${t.id}/work`, 'aria-current': work ? 'page' : null }, 'Work'),
        )
      : null,
    present,
    t
      ? h(
          'button.btn.icon.sm.ghost',
          {
            type: 'button',
            id: 'conversation-actions',
            'aria-haspopup': 'menu',
            'aria-label': `Actions for ${t.title}`,
            onclick: (e) => conversationMenu(e.currentTarget, t),
          },
          icon('more'),
        )
      : null,
    h(
      'div.top-actions',
      demoNote(),
      h('button.btn.sm.hide-sm', { type: 'button', onclick: openPalette }, icon('search', 'i-sm'), 'Jump to… ', h('kbd', '⌘K')),
      h(
        'button.btn.sm',
        {
          type: 'button',
          id: 'next-needs',
          // On a phone there’s no room for a button that says nothing needs you.
          class: n ? '' : 'hide-sm',
          onclick: nextNeedsYou,
          disabled: !n,
          'aria-keyshortcuts': 'Control+J',
        },
        n ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
        // The visible words are the button’s name; on a phone they’re hidden from sight but still read.
        h('span.sr-sm', n > 1 ? `${n} need you` : n ? 'Next that needs you' : 'Nothing needs you'),
        h('kbd.hide-sm', { 'aria-hidden': 'true' }, '⌃J'),
      ),
      h('button.btn.icon.sm.ghost', { type: 'button', 'aria-label': 'Settings', onclick: () => openSettings() }, icon('gear')),
    ),
  );
  fitter?.observe(bar);
  if (present) refitter?.observe(present, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  return bar;
}

// ── Fitting the top bar (#72) ───────────────────────────────────────────────────────────
// When the top bar doesn’t fit, it drops, in this order: the chips’ status words, their models, the project
// above the conversation’s title, the demo banner’s sentence (it folds to “Demo”), the chips’ efforts, their
// open-blocks buttons, and last their names. The rings always show. It’s measured, not a fixed breakpoint,
// because what fits depends on how many agents there are and what their chips say. What a chip drops is still in
// the overview card and the conversation’s ⋯ menu, as text, and each ring’s label reads the name and state.

const DROPS = ['state', 'model', 'crumb', 'demo', 'effort', 'asks', 'names'];
/** The room the open conversation’s title keeps, in pixels, before a chip drops anything for it. */
const TITLE_ROOM = 96;

/** Drops the fewest parts that let the top bar fit. */
function fitTopbar(bar) {
  if (!bar.isConnected) return;
  const title = bar.querySelector('.crumbs > :last-child');
  const fits = () => bar.scrollWidth <= bar.clientWidth && (!title || title.clientWidth >= Math.min(title.scrollWidth, TITLE_ROOM));
  let n = 0;
  bar.dataset.drop = '';
  while (n < DROPS.length && !fits()) bar.dataset.drop = DROPS.slice(0, ++n).join(' ');
}

// It refits when the top bar’s width changes, and when a chip’s words change, even words it had dropped: a status
// word that went from “calling tools” back to “idle” may fit again.
const fitter =
  typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
        for (const { target } of entries) {
          if (target.isConnected) fitTopbar(target);
          else fitter?.unobserve(target);
        }
      })
    : null;
const refitter =
  typeof MutationObserver === 'function'
    ? new MutationObserver((records) => {
        const bars = new Set(records.map((r) => (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest('header.topbar')));
        for (const bar of bars) if (bar) fitTopbar(bar);
      })
    : null;

/**
 * Under --demo, every view says the agents are scripted (#12). It isn’t a live region, and it can’t be closed:
 * where room is short it folds to “Demo”, and the whole sentence is still read.
 */
function demoNote() {
  if (!client.config?.demo) return null;
  return h('span.demo-note', h('span.demo-long', 'Demo mode: scripted agents'), h('span.demo-short', { 'aria-hidden': 'true' }, 'Demo'));
}

// ── Open blocks ─────────────────────────────────────────────────────────────────────────
// Asking blocks you left open from an earlier turn don’t make their agent need you. They show quietly
// beside it instead, as “1 open review”, and stay open so you can still answer them (#69).

const ASK_NOUNS = { choice: ['choice', 'choices'], form: ['form', 'forms'], confirm: ['confirmation', 'confirmations'], review: ['review', 'reviews'] };
/** @returns {{ text: string, itemId: string } | null} */
export function openAsks(se) {
  const open = itemsOf(se.threadId).filter(
    (it) => it.kind === 'block' && it.sessionId === se.id && it.valid && ASKING.has(it.block.type) && !it.answered && it.id !== se.needs?.itemId,
  );
  if (!open.length) return null;
  const types = new Set(open.map((it) => it.block.type));
  const [one, many] = types.size === 1 ? ASK_NOUNS[open[0].block.type] : ['request', 'requests'];
  return { text: plural(open.length, `open ${one}`, `open ${many}`), itemId: open[0].id };
}
/** “1 open review” for an agent: quiet text on its overview card, or a button in the top bar that goes to the block. */
function openAsksEl(se, button = false) {
  const el = button
    ? h('button.btn.sm.ghost', { type: 'button', dataset: { openAsks: se.id }, onclick: () => goToItem(el.dataset.item) })
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
  if (['session', 'persona', 'load'].includes(ch.type)) for (const el of document.querySelectorAll('[data-facts]')) paintFacts(el);
});
// ── What an agent runs with ─────────────────────────────────────────────────────────────
// Its chip says the model that answered its last turn and the effort, short; its card and the menus say the
// same with full model ids (#60). A model or effort that isn’t the one set says so in words.

/** The mock marker, or the model and effort, in an agent’s chip, kept up to date in place. */
function chipFacts(se) {
  const el = h('span.who-facts', { dataset: { facts: se.id } }, h('span.who-mock'), h('span.who-model'), h('span.who-effort'));
  paintFacts(el);
  return el;
}
function paintFacts(el) {
  const se = S().sessions[el.dataset.facts];
  if (!se) return;
  const f = factsOf(se);
  const [mock, model, effort] = el.children;
  if (mock.dataset.on !== String(f.mock)) {
    mock.dataset.on = String(f.mock);
    fill(mock, mockMarker(se));
    mock.hidden = !f.mock;
  }
  const text = (n, t) => {
    if (n.textContent !== t) n.textContent = t;
    n.hidden = !t;
  };
  text(model, f.mock ? '' : `· ${chipModel(f)}`);
  text(effort, f.mock ? '' : `· ${chipEffort(f)}`);
}

function goToItem(itemId) {
  const node = document.querySelector(`[data-key="${CSS.escape(itemId ?? '')}"]`);
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  (node.querySelector('button:not([disabled]), input, textarea, select') ?? node).focus();
}

// ── The sidebar ─────────────────────────────────────────────────────────────────────────

export function railHidden() {
  try {
    return localStorage.getItem('pb-rail') === 'hidden';
  } catch {
    return false;
  }
}

/** Shows or hides the rail (⌘\), and remembers it. */
export function toggleRail() {
  const hide = !railHidden();
  try {
    localStorage.setItem('pb-rail', hide ? 'hidden' : 'shown');
  } catch {}
  document.querySelector('.app')?.classList.toggle('rail-hidden', hide);
  const b = document.getElementById('rail-toggle');
  if (b) {
    b.setAttribute('aria-label', hide ? 'Show the sidebar' : 'Hide the sidebar');
    b.setAttribute('aria-pressed', String(!hide));
  }
}

/** ⌃J: go to the next agent that needs you, and focus what it’s waiting on. */
export function nextNeedsYou() {
  const list = needsYou().sort((a, b) => (a.needs.kind === 'failed') - (b.needs.kind === 'failed') || (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
  if (!list.length) {
    toast({ title: 'Nothing needs you right now' });
    return;
  }
  const cur = route();
  const i = list.findIndex((se) => se.threadId === cur.threadId);
  const se = list[(i + 1) % list.length];
  navigate(`#/t/${se.threadId}`);
  setTimeout(() => {
    const node = document.querySelector(`[data-key="${CSS.escape(se.needs.itemId ?? '')}"]`);
    if (node) {
      node.scrollIntoView({ block: 'center' });
      (node.querySelector('button:not([disabled]), input, textarea, select') ?? node).focus();
    }
  }, 120);
}

// ── Rail ────────────────────────────────────────────────────────────────────────────────

/** The rail for a project: its conversations (direct messages and rooms) and its topic threads. */
export function mountRail(threadId, { projectId: pid = null, view = 'thread' } = {}) {
  const el = h('nav.rail', { 'aria-label': 'Conversations' });
  const strip = h('nav.ringstrip', { 'aria-label': 'Conversations' });
  const paint = () => {
    const t = threadId ? S().threads[threadId] : null;
    const projectId = t?.projectId ?? pid ?? Object.keys(S().projects)[0];
    const threads = threadsOf(projectId).filter((x) => !x.archived);
    const others = Object.values(S().projects).filter((p) => p.id !== projectId);
    const otherNeeds = others.map((p) => [p, needsYou().filter((se) => S().threads[se.threadId]?.projectId === p.id).length]).filter(([, n]) => n);
    const archived = Object.values(S().sessions).filter((se) => se.archived && !se.deleting).length;
    fill(
      el,
      ...otherNeeds.map(([p, n]) =>
        h(
          'a.row',
          { href: '#/', style: { minHeight: '32px' } },
          h('span.g.g-needs', { 'aria-hidden': 'true' }),
          h('span.name.small', `${p.name} · ${n} need${n === 1 ? 's' : ''} you`),
        ),
      ),
      h('a.row', { href: '#/', style: { minHeight: '32px' } }, icon('agent', 'dim'), h('span.name', 'Overview'), h('kbd', '⌃J')),
      threadsRow(projectId, view === 'threads'),
      h(
        'div.rail-sec',
        h('span.label', 'Direct messages'),
        h('button.btn.ghost.icon.sm', { type: 'button', 'aria-label': 'New conversation', onclick: () => openNewThread(projectId) }, icon('plus')),
      ),
      h('div', { id: 'rail-threads' }),
      h(
        'div.rail-sec',
        h('span.label', 'Rooms'),
        h('button.btn.ghost.icon.sm', { type: 'button', 'aria-label': 'New room', onclick: () => openNewThread(projectId, { room: true }) }, icon('plus')),
      ),
      h('div', { id: 'rail-rooms' }),
      h(
        'div.rail-foot',
        h(
          'a.row',
          { href: '#/archived', style: { minHeight: '32px' } },
          icon('archive', 'dim'),
          h('span.name.dim', 'Archived'),
          h('span.small.dim', String(archived)),
        ),
        h(
          'button.row',
          {
            type: 'button',
            style: { minHeight: '32px', background: 'none', font: 'inherit', width: '100%', cursor: 'pointer' },
            onclick: () => openSettings('personas'),
          },
          icon('edit', 'dim'),
          h('span.name.dim', { style: { textAlign: 'left' } }, 'Personas'),
        ),
      ),
    );
    const rowsT = el.querySelector('#rail-threads');
    const rowsR = el.querySelector('#rail-rooms');
    rowsT.id = '';
    rowsR.id = '';
    syncList(
      rowsT,
      threads.filter((x) => x.kind !== 'room'),
      (x) => x.id,
      (x) => row(x, threadId),
      (n, x) => updateRow(n, x, threadId),
    );
    syncList(
      rowsR,
      threads.filter((x) => x.kind === 'room'),
      (x) => x.id,
      (x) => row(x, threadId),
      (n, x) => updateRow(n, x, threadId),
    );
    // Phone: a horizontal strip of rings
    syncList(
      strip,
      [{ id: '__overview' }, ...threads],
      (x) => x.id,
      (x) => stripItem(x, threadId),
      (n, x) => {
        const f = stripItem(x, threadId);
        n.replaceChildren(...f.childNodes);
        n.toggleAttribute('aria-current', x.id === threadId);
      },
    );
  };
  paint();
  // Rail rows reuse their rings, so status changes update in place and animations keep running.
  const off = client.on((ch) => {
    if (['session', 'thread', 'project', 'load', 'remove', 'persona'].includes(ch.type)) {
      if (ch.type === 'session') {
        // A topic thread’s agent changed: the Threads count may have.
        let structural = S().threads[ch.data.threadId]?.kind === 'topic';
        for (const r of document.querySelectorAll(
          `.rail pb-ring[data-session="${CSS.escape(ch.data.id)}"], .ringstrip pb-ring[data-session="${CSS.escape(ch.data.id)}"]`,
        ))
          ringFor(ch.data, r.getAttribute('size'), r);
        // The row text (state word, unread) is cheap to refresh.
        for (const n of el.querySelectorAll('a.row[data-thread]')) {
          const t = S().threads[n.dataset.thread];
          if (t) updateRow(n, t, threadId);
          else structural = true;
        }
        if (!structural) return;
      }
      paint();
    }
  });
  return { el, strip, destroy: off };
}

/** “Threads”: the project’s topic threads, with how many have replies you haven’t seen. */
function threadsRow(projectId, active) {
  const topics = topicsOf(projectId);
  const unread = topics.filter((x) => sessionsOf(x.id).some((se) => se.unread)).length;
  return h(
    'a.row',
    { href: `#/p/${projectId}/threads`, style: { minHeight: '32px' }, 'aria-current': active ? 'page' : null },
    icon('thread', 'dim'),
    h('span.name', 'Threads'),
    unread
      ? h('span.badge', { 'aria-label': `${unread} with new replies` }, String(unread))
      : topics.length
        ? h('span.small.dim', String(topics.length))
        : null,
  );
}

function rings(t) {
  const ses = sessionsOf(t.id).filter((x) => !x.archived);
  const make = (se, size) => {
    const r = ringFor(se, size);
    r.dataset.session = se.id;
    return r;
  };
  return t.kind === 'room'
    ? h(
        'span.stack',
        ses.slice(0, 4).map((se) => make(se, 'xs')),
      )
    : ses[0]
      ? make(ses[0], 'sm')
      : h('span');
}

function row(t, active) {
  const n = h('a.row', { href: `#/t/${t.id}`, dataset: { thread: t.id } });
  updateRow(n, t, active, true);
  return n;
}

function updateRow(n, t, active, fresh = false) {
  const ses = sessionsOf(t.id).filter((x) => !x.archived);
  const main = threadState(t) ?? ses[0];
  const unread = ses.reduce((a, x) => a + (x.unread ?? 0), 0);
  if (t.id === active) n.setAttribute('aria-current', 'page');
  else n.removeAttribute('aria-current');
  const named = t.kind === 'room' ? ses : main ? [main] : [];
  const who = named.length ? named.flatMap((x, i) => [i ? ', ' : '', `@${x.handle}`, mockMarker(x)]) : '@—';
  const sig = JSON.stringify([t.title, named.map((x) => [x.handle, isMock(x)]), main?.state, unread, ses.map((x) => x.id)]);
  if (!fresh && n.dataset.sig === sig) return;
  n.dataset.sig = sig;
  const oldRings = n.querySelector('.ring-slot');
  const slot = oldRings && n.dataset.members === ses.map((x) => x.id).join(',') ? oldRings : h('span.ring-slot', rings(t));
  n.dataset.members = ses.map((x) => x.id).join(',');
  fill(
    n,
    slot,
    h('span.name', h('span', t.title), h('span.sub', who, h('span.state-word', main ? ` · ${stateWord(main.state).toLowerCase()}` : ''))),
    unread ? h('span.badge', { 'aria-label': `${unread} unread` }, String(unread)) : null,
  );
}

function stripItem(x, active) {
  if (x.id === '__overview')
    return h('a', { href: '#/' }, h('span.i.i-agent', { style: { width: '28px', height: '28px' }, 'aria-hidden': 'true' }), h('span', 'Overview'));
  const ses = sessionsOf(x.id).filter((s) => !s.archived);
  const unread = ses.reduce((a, s) => a + (s.unread ?? 0), 0);
  return h(
    'a',
    { href: `#/t/${x.id}`, 'aria-current': x.id === active ? 'page' : null },
    rings(x),
    unread ? h('span.badge', String(unread)) : null,
    h('span', x.title),
  );
}

// ── Overview ────────────────────────────────────────────────────────────────────────────

export function mountOverview({ archived = false } = {}) {
  const el = h('main.ov', { id: 'main', tabindex: '-1' });
  const grid = h('div.ov-grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' } });
  const headEl = h('div.ov-head');
  const archive = h('div');
  el.append(...[headEl, archived ? null : installLine(), grid, archive].filter((x) => x !== null));
  const order = (se) => (se.needs ? 0 : busy(se) ? 1 : 2);
  const paint = () => {
    // A topic thread’s agent gets a column only while it’s working or waiting for you.
    const live = liveSessions()
      .filter((se) => S().threads[se.threadId]?.kind !== 'topic' || busy(se) || se.needs)
      .sort((a, b) => order(a) - order(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const n = needsYou().length;
    const finished = live.filter((se) => se.unread && !se.needs).length;
    headEl.replaceChildren(
      h(
        'div.grow',
        h('h1.title', { style: { fontSize: '20px' } }, archived ? 'Archived sessions' : 'Overview'),
        h(
          'p.small.dim',
          archived
            ? 'Sessions you archived. Restore one to pick it up again.'
            : [
                `${plural(live.length, 'live session')} in ${plural(Object.keys(S().projects).length, 'project')}`,
                n ? [' · ', h('span.st-needs', `${n} need${n === 1 ? 's' : ''} you`)] : '',
                finished ? ` · ${finished} finished` : '',
              ],
        ),
      ),
      archived
        ? h('a.btn', { href: '#/' }, 'Back to the overview')
        : h('button.btn', { type: 'button', onclick: () => openNewAgent({}) }, icon('plus'), 'New agent'),
    );
    if (archived) {
      grid.replaceChildren();
      archive.replaceChildren(archivedList());
      return;
    }
    // A fresh install has no projects yet, so the empty overview leads to making one.
    if (!live.length)
      grid.replaceChildren(
        Object.keys(S().projects).length
          ? h('div.ov-empty', 'No live sessions. Open a project above, or create an agent.')
          : h(
              'div.ov-empty',
              h('p', 'Create a project to start, or create an agent.'),
              h('button.btn', { type: 'button', style: { marginTop: '12px' }, onclick: () => openSettings('projects') }, icon('plus'), 'New project'),
            ),
      );
    else
      syncList(
        grid,
        live,
        (se) => se.id,
        (se) => card(se),
        (node, se) => updateCard(node, se),
      );
    archive.replaceChildren(archivedList(true));
  };
  paint();
  let t = 0;
  const off = client.on((ch) => {
    if (!['session', 'thread', 'load', 'remove', 'project', 'app', 'persona'].includes(ch.type)) return;
    if (ch.type === 'session') {
      const node = grid.querySelector(`[data-key="${CSS.escape(ch.data.id)}"]`);
      if (node) {
        updateCard(node, ch.data);
        clearTimeout(t);
        t = setTimeout(paint, 300);
        return;
      }
    }
    paint();
  });
  return { el, destroy: off };
}

/**
 * When Postbox looked for Claude Code at startup and didn’t find it, the overview says what agents run on until
 * then, and how to install it (#12). It shows from the first run, on a fresh install’s empty overview, until
 * Claude Code is installed and Postbox restarted.
 */
function installLine() {
  const lead = installNote(client.config ?? {});
  if (!lead) return null;
  return h(
    'div.callout.warn.install-note',
    icon('warn'),
    h(
      'div',
      h('p', lead),
      h(
        'p.small',
        'To run real agents, install Claude Code so ',
        h('code', 'claude --version'),
        ' works, or set ',
        h('code', 'POSTBOX_CLAUDE_BIN'),
        ' to where it is, then restart Postbox. The README’s “Run real agents” says more.',
      ),
    ),
  );
}

function archivedList(collapsed = false) {
  const list = Object.values(S().sessions).filter((se) => se.archived && !se.deleting);
  if (!list.length) return collapsed ? h('span') : h('p.empty-note', 'Nothing is archived.');
  const table = h(
    'table.tbl',
    h(
      'tbody',
      list.map((se) => {
        const t = S().threads[se.threadId];
        const ring = ringFor(se, 'xs');
        return h(
          'tr',
          h('td', h('span.row-flex', ring, h('b', `@${se.handle}`), mockMarker(se))),
          h('td', `${S().projects[t?.projectId]?.name ?? ''} · ${t?.title ?? ''}`),
          h('td.dim.small', `Archived ${ago(se.archivedAt ?? se.updatedAt ?? Date.now())}`),
          h(
            'td.act',
            h(
              'button.btn.sm',
              { type: 'button', onclick: () => api(`/api/sessions/${se.id}/restore`, {}).catch((e) => toast({ title: 'Couldn’t restore', text: e.message })) },
              'Restore',
            ),
            h('a.btn.sm.ghost', { href: `#/t/${se.threadId}` }, 'Open'),
          ),
        );
      }),
    ),
  );
  return h(
    'details.block',
    { open: !collapsed || undefined },
    h(
      'summary.block-head',
      { style: { cursor: 'pointer', listStyle: 'none' } },
      icon('archive', 'dim'),
      h('span.title.grow', 'Archived'),
      h('span.small.dim', plural(list.length, 'session')),
    ),
    table,
  );
}

function card(se) {
  const node = h('article.ov-col');
  // The whole card opens the agent’s conversation; buttons, links and fields inside it keep their own jobs.
  // The name is the real link, for the keyboard and screen readers.
  node.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input, select, textarea, summary, label, [role=menu]') || getSelection()?.toString()) return;
    const s = S().sessions[node.dataset.key];
    if (s) navigate(hrefOf(s.threadId));
  });
  updateCard(node, se, true);
  return node;
}

function updateCard(node, se, fresh = false) {
  const t = S().threads[se.threadId];
  if (!t) return;
  const project = S().projects[t.projectId];
  const runs = factsText(factsOf(se));
  const sig = JSON.stringify([
    runs,
    se.state,
    se.needs,
    se.currentStep,
    se.glimpse,
    se.lastMessage,
    se.toolCount,
    se.toolCalls,
    se.agentMessages,
    se.subagents,
    se.compactions,
    se.ctx,
    se.unread,
    t.title,
    openAsks(se)?.text,
  ]);
  if (!fresh && node.dataset.sig === sig) return;
  node.dataset.sig = sig;
  node.classList.toggle('needs', !!se.needs);
  node.setAttribute('aria-label', `@${se.handle}${isMock(se) ? ', mock' : ''}, ${stateWord(se.state).toLowerCase()}`);
  const ring = node.querySelector('.oc-head pb-ring') ?? Object.assign(document.createElement('pb-ring'), {});
  ringFor(se, 'lg', ring);
  ring.dataset.session = se.id;
  const stateLine = se.needs
    ? h(
        'span.small.st-needs',
        se.needs.kind === 'failed'
          ? `Failed · ${ago(se.finishedAt ?? Date.now())}`
          : `Needs you · waiting ${ago(se.finishedAt ?? Date.now()).replace(' ago', '')}`,
      )
    : busy(se)
      ? h('span.small', { class: `st-${se.state}` }, `${stateWord(se.state)} · ${ago(se.startedAt).replace(' ago', '')}`)
      : h(
          'span.small.dim',
          se.unread
            ? [`Finished ${ago(se.finishedAt ?? Date.now())} `, h('span.badge', String(se.unread))]
            : `Idle${se.finishedAt ? ` since ${timeOf(se.finishedAt)}` : ''}`,
        );
  const sec = (label, ...content) => h('div.oc-sec', h('span.label', label), ...content);
  const quick = quickAnswer(se);
  fill(
    node,
    h(
      'div.oc-head',
      ring,
      h(
        'div.who-name',
        h(
          'a.oc-link',
          { href: hrefOf(t.id) },
          h('span.oc-name', h('b', `@${se.handle}`), mockMarker(se)),
          h('span.small.dim', `${project?.name ?? ''} · ${t.kind === 'topic' ? 'topic thread: ' : ''}${t.title}`),
        ),
        stateLine,
        openAsksEl(se),
      ),
      h(
        'button.btn.icon.sm.ghost',
        { type: 'button', 'aria-label': `Session actions for @${se.handle}`, 'aria-haspopup': 'menu', onclick: (e) => sessionMenu(e.currentTarget, se) },
        icon('more'),
      ),
      // What it runs with, in full, on a line of its own: nothing the top bar drops at a narrow width is lost (#60).
      h('span.small.dim.oc-runs', runs),
    ),
    se.needs
      ? sec(
          se.needs.kind === 'failed' ? 'Failed' : 'Needs you',
          h('p', se.needs.text),
          quick ?? h('a.btn.sm', { href: `#/t/${se.threadId}`, style: { alignSelf: 'flex-start' } }, 'Open conversation'),
        )
      : null,
    sec('Current step', h('p', { class: busy(se) ? '' : 'dim' }, se.currentStep || '—'), busy(se) && se.glimpse ? h('p.glimpse', se.glimpse) : null),
    se.lastMessage ? sec('Last message', h('p.clamp2', se.lastMessage)) : null,
    sec(
      h('span', 'Tool calls ', h('span.dim', String(se.toolCount ?? 0))),
      se.toolCalls?.length
        ? h(
            'ul.mini-list',
            se.toolCalls
              .slice(0, 4)
              .map((c) =>
                h(
                  'li',
                  h(`span.g.g-${c.state === 'running' ? 'running' : c.state === 'failed' ? 'failed' : 'done'}`, { role: 'img', 'aria-label': c.state }),
                  h('span.t.mono', c.name),
                  h('span.small.dim', c.ms ? `${(c.ms / 1000).toFixed(1)} s` : ''),
                ),
              ),
            se.toolCount > 4 ? h('li.small.dim', `+ ${se.toolCount - 4} more`) : null,
          )
        : h('p.small.dim', 'None yet'),
    ),
    sec(h('span', 'Agent messages ', se.agentMessages?.length ? h('span.dim', String(se.agentMessages.length)) : null), agentMessages(se)),
    sec(
      h('span', 'Subagents ', se.subagents?.length ? h('span.dim', String(se.subagents.length)) : null),
      se.subagents?.length
        ? h(
            'ul.mini-list',
            se.subagents.map((s) =>
              h(
                'li',
                h('pb-ring', { name: s.name, state: s.state, ctx: String(s.ctx), size: 'xs' }),
                h('span.t', h('b', s.name), s.doing ? h('span.dim', ` ${s.doing}`) : null),
              ),
            ),
          )
        : h('p.small.dim', 'None'),
    ),
    h(
      'div.oc-sec.stats',
      h('div', h('span.label', 'Context'), h('b', `${se.ctx}%`)),
      h('div', h('span.label', 'Compactions'), h('b', String(se.compactions ?? 0))),
      h('div', h('span.label', busy(se) ? 'Running' : 'Started'), h('b', ago(se.startedAt).replace(' ago', ''))),
    ),
  );
}

function agentMessages(se) {
  if (!se.agentMessages?.length) return h('p.small.dim', 'None');
  return h(
    'ul.mini-list.small',
    se.agentMessages.slice(0, 3).map((m) => {
      // Each exchange happened in a side thread; the line opens it.
      const pair = [se.handle, m.other].sort().join('|');
      const side = Object.values(S().threads).find((x) => x.kind === 'side' && x.pair === pair);
      const text = [m.dir === 'to' ? 'to ' : 'from ', h('b', `@${m.other}`), `: ${m.text}`];
      return h(
        'li',
        h('span.i.i-thread.i-sm.dim', { 'aria-hidden': 'true', style: m.dir === 'from' ? { transform: 'scaleX(-1)' } : {} }),
        side ? h('a.t.oc-msg', { href: hrefOf(side.id) }, ...text) : h('span.t', ...text),
      );
    }),
  );
}

/** Answer a permission request, a refusal, an app’s waiting sends, or a simple choice or confirm right on the card. */
function quickAnswer(se) {
  const kind = se.needs?.kind;
  if (kind === 'permission' || kind === 'denial' || kind === 'appsend') {
    const it = (S().items[se.threadId] ?? []).find((x) => x.id === se.needs.itemId);
    if (it?.status !== 'open') return null;
    const act = (action) =>
      api(`/api/threads/${se.threadId}/items/${it.id}/act`, { action }).catch((e) =>
        toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }),
      );
    const buttons =
      kind === 'permission' || kind === 'appsend'
        ? [
            h('button.btn.sm', { type: 'button', onclick: () => act('allow') }, 'Allow'),
            h('button.btn.sm', { type: 'button', onclick: () => act('deny') }, 'Don’t allow'),
          ]
        : [
            h('button.btn.sm', { type: 'button', onclick: () => act('once') }, 'Allow once and retry'),
            h('button.btn.sm', { type: 'button', onclick: () => act('always') }, `Always allow ${it.rules.alwaysWords}`),
          ];
    return h(
      'div.col',
      it.detail ? h('pre.md-code.perm-detail', h('code', it.detail.slice(0, 400))) : null,
      h('div.row-flex.wrap', ...buttons, h('a.btn.sm.ghost', { href: `#/t/${se.threadId}` }, 'Open conversation')),
    );
  }
  if (kind !== 'block') return null;
  const it = (S().items[se.threadId] ?? []).find((x) => x.id === se.needs.itemId);
  if (!it?.valid) return null;
  const b = it.block;
  const act = (action, values) =>
    api(`/api/threads/${se.threadId}/items/${it.id}/act`, { action, values }).catch((e) =>
      toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }),
    );
  if (b.type === 'confirm')
    return h(
      'div.row-flex.wrap',
      h('button.btn.sm', { type: 'button', onclick: () => act('confirm', {}) }, b.confirmLabel),
      h('button.btn.sm', { type: 'button', onclick: () => act('cancel', {}) }, b.cancelLabel ?? 'Cancel'),
      h('a.btn.sm.ghost', { href: `#/t/${se.threadId}` }, 'Open conversation'),
    );
  if (b.type === 'choice' && !b.other) {
    const picked = new Set();
    const send = h(
      'button.btn.sm.send',
      { type: 'button', disabled: true, onclick: () => act('choose', { selected: [...picked] }) },
      b.multiple ? 'Send choices' : 'Send choice',
    );
    const chips = h(
      'div.chips',
      { role: b.multiple ? 'group' : 'radiogroup', 'aria-label': b.title ?? 'Options' },
      b.options.map((o) => {
        const c = h(
          'button.chip.sm',
          {
            type: 'button',
            // One answer: radios, which say checked. Several: toggle buttons, which say pressed.
            role: b.multiple ? null : 'radio',
            [b.multiple ? 'aria-pressed' : 'aria-checked']: 'false',
            onclick: () => {
              if (picked.has(o.id)) picked.delete(o.id);
              else {
                if (!b.multiple) picked.clear();
                picked.add(o.id);
              }
              if (b.max && picked.size > b.max) picked.delete(o.id);
              for (const x of chips.children) {
                const on = picked.has(x.dataset.id);
                x.classList.toggle('on', on);
                if (b.multiple) x.setAttribute('aria-pressed', String(on));
                else x.setAttribute('aria-checked', String(on));
              }
              send.disabled = !picked.size;
              send.textContent = b.multiple ? (picked.size ? `Send ${plural(picked.size, 'choice')}` : 'Send choices') : 'Send choice';
            },
            dataset: { id: o.id },
          },
          o.label,
        );
        return c;
      }),
    );
    return [chips, h('div.row-flex', send, h('a.btn.sm.ghost', { href: `#/t/${se.threadId}` }, 'Open conversation'))];
  }
  return null;
}

export function sessionMenu(anchor, se) {
  openMenu(
    anchor,
    [
      { label: 'Open conversation', icon: 'thread', run: () => navigate(`#/t/${se.threadId}`) },
      {
        label: [`Edit @${se.handle} persona`, mockMarker(se)],
        icon: 'edit',
        kbd: 'Personas',
        // What it runs with, as text (#60).
        desc: factsText(factsOf(se)),
        run: () => openSettings('personas', se.personaId),
      },
      ...(busy(se) ? [{ label: 'Stop', icon: 'x', run: () => api(`/api/sessions/${se.id}/stop`, {}) }] : []),
      'hr',
      {
        label: 'Archive session',
        icon: 'archive',
        desc: 'Stops it; keeps the conversation read-only. Restore any time.',
        run: () =>
          api(`/api/sessions/${se.id}/archive`, {}).then(() =>
            toast({ title: `Archived @${se.handle}’s session`, action: { label: 'Restore', run: () => api(`/api/sessions/${se.id}/restore`, {}) } }),
          ),
      },
      {
        label: 'Delete session…',
        icon: 'trash',
        danger: true,
        desc: `${sessionsOf(se.threadId).length > 1 ? 'Takes it out of the room and erases its apps' : 'Erases the conversation and its apps'}. The persona stays.`,
        run: () => confirmDelete(se),
      },
    ],
    { label: `Session actions for @${se.handle}` },
  );
}

/** The conversation’s menu in the top bar: rename it, bring in an agent, or delete it. */
function conversationMenu(anchor, t) {
  const room = t.kind === 'room';
  openMenu(
    anchor,
    [
      { label: 'Rename…', icon: 'edit', run: () => openRename(t.id) },
      {
        label: 'Add an agent…',
        icon: 'agent',
        desc: room ? 'It joins the room' : 'This conversation becomes a room',
        run: () => openNewAgent({ threadId: t.id }),
      },
      {
        label: 'Work',
        icon: 'file',
        desc: 'What its agents changed, ran and published',
        run: () => navigate(`#/t/${t.id}/work`),
      },
      {
        label: 'Permissions…',
        icon: 'gear',
        desc: room ? 'An agent’s mode, rules and folders here' : 'Its mode, rules and folders here',
        run: () => openPermissions({ threadId: t.id }),
      },
      'hr',
      ...agentLines(t),
      {
        label: `Delete ${room ? 'room' : 'conversation'}…`,
        icon: 'trash',
        danger: true,
        desc: 'Erases it and its sessions. The personas stay.',
        run: () => confirmDeleteThread(t.id),
      },
    ],
    { label: `Actions for ${t.title}` },
  );
}

/**
 * Each agent in the conversation, with its backend, model, effort and state as text: everything its chip in the
 * top bar shows, and what a narrow window drops from it (#60, #72). Choosing one opens its persona.
 */
function agentLines(t) {
  const ses = sessionsOf(t.id).filter((x) => !x.archived);
  if (!ses.length) return [];
  return [
    { heading: ses.length > 1 ? 'Agents' : 'Agent' },
    ...ses.map((se) => ({
      label: [`@${se.handle}`, mockMarker(se)],
      icon: 'agent',
      desc: `${factsText(factsOf(se))} · ${stateWord(se.state).toLowerCase()}`,
      kbd: 'Edit',
      run: () => openSettings('personas', se.personaId),
    })),
    'hr',
  ];
}

export function afterDelete(se, until) {
  undoToast({
    text: `Deleted @${se.handle}’s session “${S().threads[se.threadId]?.title ?? ''}”`,
    until,
    onUndo: () => api(`/api/sessions/${se.id}/undo-delete`, {}).catch((e) => toast({ title: 'Too late to undo', text: e.message })),
  });
}

export { renderMarkdown, toPlainText };

// ── Threads ─────────────────────────────────────────────────────────────────────────────
// A project’s topic threads, newest reply first. Each one is a fork of an agent’s session at the message it
// started from, so this is also the list of branches its agents are holding.

export function mountThreads(projectId) {
  const el = h('main.threads-view', { id: 'main', tabindex: '-1' });
  const paint = () => {
    const project = S().projects[projectId];
    const topics = topicsOf(projectId)
      .map((t) => {
        const parent = S().threads[t.parentId];
        const root = (S().items[t.parentId] ?? []).find((x) => x.id === t.rootItemId);
        const ses = sessionsOf(t.id).filter((x) => !x.archived);
        return { t, parent, root, ses, unread: ses.reduce((a, x) => a + (x.unread ?? 0), 0), last: root?.lastReplyAt ?? t.createdAt };
      })
      .sort((a, b) => b.last - a.last);
    fill(
      el,
      h(
        'div.ov-head',
        h(
          'div.grow',
          h('h1.title', { style: { fontSize: '20px' } }, 'Threads'),
          h(
            'p.small.dim',
            `Topic threads in ${project?.name ?? 'this project'}. Each one is a branch of an agent’s session, so a side topic stays out of the conversation’s memory.`,
          ),
        ),
      ),
      topics.length
        ? h(
            'ul.thread-list',
            topics.map(({ t, parent, root, ses, unread, last }) =>
              h(
                'li',
                h(
                  'a.thread-card',
                  { href: hrefOf(t.id) },
                  h(
                    'span.stack',
                    ses.slice(0, 3).map((se) => {
                      const r = ringFor(se, 'xs');
                      r.dataset.session = se.id;
                      return r;
                    }),
                  ),
                  h(
                    'span.grow',
                    h('b', t.title),
                    h(
                      'span.small.dim',
                      { style: { display: 'block' } },
                      `in ${parent?.title ?? ''} · ${plural(root?.replies ?? 0, 'reply', 'replies')} · ${ses.map((x) => `@${x.handle}`).join(', ') || 'no agent'} · ${ago(last)}`,
                    ),
                  ),
                  unread ? h('span.badge', { 'aria-label': `${unread} new` }, String(unread)) : null,
                ),
              ),
            ),
          )
        : h('p.empty-note', 'No topic threads yet. To start one, choose Reply in thread under any message in a conversation.'),
    );
  };
  paint();
  const off = client.on((ch) => {
    if (['thread', 'session', 'load', 'remove', 'item.patch'].includes(ch.type)) paint();
  });
  return { el, destroy: off };
}

/** A project with no conversations yet. */
export function mountEmptyProject(projectId) {
  const project = S().projects[projectId];
  const el = h(
    'main.threads-view',
    { id: 'main', tabindex: '-1' },
    h('div.ov-head', h('div.grow', h('h1.title', { style: { fontSize: '20px' } }, project?.name ?? 'Project'), h('p.small.dim.mono', project?.folder ?? ''))),
    h(
      'div.block',
      h('div.block-body', h('p', 'No conversations here yet. Start one with an agent, or create a new agent for this project.')),
      h(
        'div.block-foot',
        h('button.btn', { type: 'button', onclick: () => openNewThread(projectId) }, icon('plus'), 'New conversation'),
        h('button.btn', { type: 'button', onclick: () => openNewAgent({ projectId }) }, icon('agent'), 'New agent'),
      ),
    ),
  );
  return { el, destroy() {} };
}
