// The shell: top bar, rail (conversations and rooms with rings), the phone ring strip, and the overview — a card
// for each session that needs you or is working, with quick answers, tool calls, subagents, agent messages and
// stats, and a row for each idle conversation.

import { factsText, installNote } from '/shared/agent-facts.mjs';
import { renderMarkdown, toPlainText } from '/shared/markdown.mjs';
import { needsYouNow } from '/shared/needs.mjs';
import { factsOf, isMock, mockMarker } from './agent-facts.mjs';
import { agentsSection, joinedWhy, openAgentPanel } from './agents.mjs';
import { api, busy, client, hrefOf, liveSessions, needsYou, sessionsOf, stopSession, threadState, threadsOf, topicsOf, whereOf } from './client.mjs';
import { ago, fill, h, icon, plural, syncList, timeOf } from './dom.mjs';
import { nextNeedsYou } from './needs-nav.mjs';
import { openAsks, openAsksEl } from './open-asks.mjs';
import { openPermissions } from './permissions.mjs';
import { railHidden, railShown, toggleRail } from './rail-collapse.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { confirmDelete, confirmDeleteThread, openNewAgent, openNewThread, openPalette, openRename, openSettings } from './sheets.mjs';
import { recordingBadge, telemetryItems } from './telemetry.mjs';
import { closeWork, menuAnchor, navigate, openMenu, openWork, route, toast, undoToast } from './ui.mjs';

export { railHidden, toggleRail };

const S = () => client.state;

/**
 * The top bar: the places menu, the path to the open conversation and its two views, a ring for each agent in
 * it, and the global actions. The agents’ words live in the sidebar’s Agents section (#105), so the title and
 * the project have room; each ring opens the agent’s quick panel, for when the sidebar is hidden or the window
 * is narrow.
 */
export function topbar({ title = '', threadId = null, projectId = null }) {
  const t = threadId ? S().threads[threadId] : null;
  const pid = t?.projectId ?? projectId;
  const project = pid ? S().projects[pid] : null;
  const here = t ? sessionsOf(threadId).filter((x) => !x.archived) : [];
  const ring = (se) => {
    const r = ringFor(se, 'xs');
    r.dataset.session = se.id;
    return r;
  };
  const present = t
    ? h(
        'div.present',
        { role: 'group', 'aria-label': 'Agents here' },
        here.map((se) => {
          // The ring’s own label is the button’s name: the agent’s name and state, kept up to date in place.
          // One the person didn’t add says why it’s here on hover (#110); its row in the sidebar says it in words.
          const b = h(
            'button.ring-btn',
            {
              type: 'button',
              id: `top-ring-${se.id}`,
              'aria-haspopup': needsYouNow(se) ? null : 'dialog',
              'aria-expanded': 'false',
              title: joinedWhy(se),
              onclick: () => openAgentPanel(se.id, b),
            },
            ring(se),
          );
          return b;
        }),
        // Where even the rings don’t fit, they fold into one stack, whose menu leads to each agent’s panel.
        here.length > 1
          ? h(
              'button.ring-stack',
              { type: 'button', id: 'top-ring-stack', 'aria-haspopup': 'menu', onclick: (e) => agentsMenu(e.currentTarget, threadId) },
              h('span.stack', here.slice(0, 4).map(ring)),
            )
          : null,
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
            'aria-label': railShown() ? 'Hide the sidebar' : 'Show the sidebar',
            'aria-pressed': String(railShown()),
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
      // The crumb above the title (.up) is the first thing the top bar drops for room (#72).
      project
        ? [icon('right', `i-sm${up}`), h(`a.crumb${up}`, { href: `#/p/${project.id}` }, project.name)]
        : [icon('right', `i-sm${up}`), h(t || title ? `a.crumb${up}` : 'span.title', t || title ? { href: '#/' } : {}, 'Overview')],
      title ? [icon('right', 'i-sm'), h('span.title', title), recordingBadge(t)] : null,
    ),
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
      // The conversation’s Work in the right pane (#132), opened and closed here: the first of its side views’ buttons.
      // It says Work in words beside its icon, as Jump to does (#183).
      t
        ? h(
            'button.btn.sm',
            {
              type: 'button',
              id: 'work-button',
              'aria-pressed': String(route().slot === 'work'),
              onclick: () => (route().slot === 'work' ? closeWork(t.id) : openWork(t.id)),
            },
            icon('file', 'i-sm'),
            // The visible word is its name; on a phone it’s hidden from sight but still read, and the icon stays.
            h('span.sr-sm', 'Work'),
          )
        : null,
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
  // Fitted once it’s on the page too: the observer’s first call waits for a frame, which a hidden tab can hold back.
  queueMicrotask(() => fitTopbar(bar));
  return bar;
}

/** The folded rings’ menu: each agent with its state and what it runs with, now, leading to its quick panel. */
function agentsMenu(anchor, threadId) {
  openMenu(
    anchor,
    sessionsOf(threadId)
      .filter((x) => !x.archived)
      .map((se) => ({
        label: [`@${se.handle}`, mockMarker(se)],
        icon: 'agent',
        desc: `${stateWord(se.state)} · ${factsText(factsOf(se))}`,
        // Focus goes back to the stack when the panel closes; the stack opens a menu, not the panel, so it isn’t marked open.
        run: () => openAgentPanel(se.id),
      })),
    { label: 'Agents here' },
  );
}

// ── Fitting the top bar (#72) ───────────────────────────────────────────────────────────
// With the agents’ words in the sidebar (#105), only a narrow window is short of room. Then the top bar drops, in
// this order: the project above the conversation’s title; the demo banner’s sentence (it folds to “Demo”); and
// last the rings fold into one stack. It’s measured, not a fixed breakpoint, because what fits depends on how many
// agents there are.

const DROPS = ['crumb', 'demo', 'rings'];
/** The room the open conversation’s title keeps, in pixels, before the top bar drops anything for it. */
const TITLE_ROOM = 96;

/** Drops the fewest parts that let the top bar fit. */
function fitTopbar(bar) {
  if (!bar.isConnected) return;
  const title = bar.querySelector('.crumbs > :last-child');
  const fits = () => bar.scrollWidth <= bar.clientWidth && (!title || title.clientWidth >= Math.min(title.scrollWidth, TITLE_ROOM));
  // One agent has no stack to fold into, so its ring always stays.
  const drops = bar.querySelector('.ring-stack') ? DROPS : DROPS.filter((d) => d !== 'rings');
  let n = 0;
  bar.dataset.drop = '';
  while (n < drops.length && !fits()) bar.dataset.drop = drops.slice(0, ++n).join(' ');
}

// It refits when the top bar’s width changes.
const fitter =
  typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
        for (const { target } of entries) {
          if (target.isConnected) fitTopbar(target);
          else fitter?.unobserve(target);
        }
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

// ── The sidebar ─────────────────────────────────────────────────────────────────────────

/** Which build this is, in tiny text under Personas: “v0.3.0 · 1a2b3c4”, so a screenshot says which build it came from. */
function buildLine() {
  const b = client.config?.build;
  if (!b?.version) return null;
  return h(
    'p.rail-build',
    { 'aria-label': `Postbox version ${b.version}${b.commit ? `, commit ${b.commit}` : ''}` },
    `v${b.version}${b.commit ? ` · ${b.commit}` : ''}`,
  );
}

// ── Rail ────────────────────────────────────────────────────────────────────────────────

/**
 * The rail for a project: the open conversation’s agents (#105), its conversations (direct messages and rooms)
 * and its topic threads.
 */
export function mountRail(threadId, { projectId: pid = null, view = 'thread' } = {}) {
  const el = h('nav.rail', { 'aria-label': 'Conversations' });
  const strip = h('nav.ringstrip', { 'aria-label': 'Conversations' });
  // Kept between repaints: it follows its own agents.
  const agents = threadId ? agentsSection(threadId) : null;
  const paint = () => {
    const t = threadId ? S().threads[threadId] : null;
    const projectId = t?.projectId ?? pid ?? Object.keys(S().projects)[0];
    const threads = threadsOf(projectId).filter((x) => !x.archived);
    const others = Object.values(S().projects).filter((p) => p.id !== projectId);
    const otherNeeds = others.map((p) => [p, needsYou().filter((se) => S().threads[se.threadId]?.projectId === p.id).length]).filter(([, n]) => n);
    // Archived counts conversations, as its page lists them (#101).
    const archived = new Set(
      Object.values(S().sessions)
        .filter((se) => se.archived && !se.deleting && !se.retiredFork)
        .map((se) => convOf(se.threadId)),
    ).size;
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
      agents?.el,
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
        buildLine(),
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
  return {
    el,
    strip,
    destroy() {
      off();
      agents?.destroy();
    },
  };
}

/** “Threads”: the project’s topic threads, with how many have replies you haven’t seen. */
function threadsRow(projectId, active) {
  const topics = topicsOf(projectId);
  const unread = topics.filter((x) => x.unread).length;
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

const busyOrNeeds = (se) => busy(se) || se.state === 'needs' || se.state === 'stopping';

function row(t, active) {
  const n = h('a.row', { href: `#/t/${t.id}`, dataset: { thread: t.id } });
  updateRow(n, t, active, true);
  return n;
}

function updateRow(n, t, active, fresh = false) {
  const ses = sessionsOf(t.id).filter((x) => !x.archived);
  // Its state counts its side threads (#121): an agent at work in one shows here, and says where.
  const lead = threadState(t);
  const main = lead && ses.includes(lead) ? lead : (ses[0] ?? lead);
  const away = lead && (lead.sideTurn || !ses.includes(lead)) && busyOrNeeds(lead) ? ' in a side thread' : '';
  const unread = ses.reduce((a, x) => a + (x.unread ?? 0), 0);
  if (t.id === active) n.setAttribute('aria-current', 'page');
  else n.removeAttribute('aria-current');
  const named = t.kind === 'room' ? ses : main ? [main] : [];
  const who = named.length ? named.flatMap((x, i) => [i ? ', ' : '', `@${x.handle}`, mockMarker(x)]) : '@—';
  const word = lead ? ` · ${stateWord(lead.state).toLowerCase()}${away}` : '';
  const sig = JSON.stringify([t.title, named.map((x) => [x.handle, isMock(x)]), word, unread, ses.map((x) => x.id)]);
  if (!fresh && n.dataset.sig === sig) return;
  n.dataset.sig = sig;
  const oldRings = n.querySelector('.ring-slot');
  const slot = oldRings && n.dataset.members === ses.map((x) => x.id).join(',') ? oldRings : h('span.ring-slot', rings(t));
  n.dataset.members = ses.map((x) => x.id).join(',');
  fill(
    n,
    slot,
    h('span.name', h('span', t.title), h('span.sub', who, h('span.state-word', word))),
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
  // Idle conversations, one compact row each, below what needs you and what’s working (#3).
  const rows = h('ul.ov-rows', { 'aria-labelledby': 'ov-idle-h' });
  const idleSec = h('section.ov-idle', h('h2.label', { id: 'ov-idle-h' }, 'Idle'), rows);
  const archive = h('div');
  el.append(...[headEl, archived ? null : installLine(), grid, idleSec, archive].filter((x) => x !== null));
  const order = (se) => (se.needs ? 0 : 1);
  const paint = () => {
    const live = liveSessions();
    // A card for each session that needs you or is working, its side and topic threads’ forks too (#121).
    const active = live.filter((se) => se.needs || busy(se)).sort((a, b) => order(a) - order(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const idle = idleConversations(live, active);
    const n = needsYou().length;
    const finished = live.filter((se) => se.unread && !se.needs).length;
    headEl.replaceChildren(
      h(
        'div.grow',
        h('h1.title', { style: { fontSize: '20px' } }, archived ? 'Archived' : 'Overview'),
        h(
          'p.small.dim',
          archived
            ? 'Conversations you archived or that sat idle, and agents you archived on their own. Restore one to pick it up again.'
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
      idleSec.hidden = true;
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
        active,
        (se) => se.id,
        (se) => card(se),
        (node, se) => updateCard(node, se),
      );
    grid.hidden = !!live.length && !active.length;
    idleSec.hidden = !idle.length;
    syncList(
      rows,
      idle,
      (c) => c.t.id,
      (c) => idleRow(c),
      (node, c) => updateIdleRow(node, c),
    );
    archive.replaceChildren(archivedList(true));
  };
  paint();
  let t = 0;
  // A card’s change re-sorts the columns a moment later, but not while a menu opened from a card is open: the
  // card would move out from under the menu and the pointer, and a second click on its ⋯ would miss (#29).
  const resort = () => {
    if (grid.contains(menuAnchor()) || rows.contains(menuAnchor())) t = setTimeout(resort, 300);
    else paint();
  };
  const off = client.on((ch) => {
    if (!['session', 'thread', 'load', 'remove', 'project', 'app', 'persona'].includes(ch.type)) return;
    if (ch.type === 'session') {
      const node = grid.querySelector(`[data-key="${CSS.escape(ch.data.id)}"]`);
      if (node) {
        updateCard(node, ch.data);
        clearTimeout(t);
        t = setTimeout(resort, 300);
        return;
      }
    }
    // Any other change repaints now, unless a menu from a card or a row is open: then once it closes.
    clearTimeout(t);
    resort();
  });
  return {
    el,
    destroy() {
      off();
      clearTimeout(t);
    },
  };
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

/**
 * What’s archived, one row per conversation with its archived agents (#101): a conversation archived whole, or an
 * agent archived on its own. Restore brings back every agent the row lists.
 */
function archivedList(collapsed = false) {
  const by = new Map();
  for (const se of Object.values(S().sessions)) {
    const t = S().threads[convOf(se.threadId)];
    if (!se.archived || se.deleting || se.retiredFork || !t || t.deleting) continue; // a retired fork can’t come back (#228)
    by.set(t.id, [...(by.get(t.id) ?? []), se]);
  }
  const at = (ses) => Math.max(...ses.map((se) => se.archivedAt ?? se.updatedAt ?? 0));
  const list = [...by].sort((a, b) => at(b[1]) - at(a[1]));
  if (!list.length) return collapsed ? h('span') : h('p.empty-note', 'Nothing is archived.');
  const table = h(
    'table.tbl',
    h(
      'tbody',
      list.map(([id, ses]) => {
        const t = S().threads[id];
        return h(
          'tr',
          { dataset: { thread: id } },
          h(
            'td',
            h(
              'span.row-flex',
              ses.slice(0, 4).map((se) => ringFor(se, 'xs')),
              h(
                'span',
                ses.flatMap((se, i) => [i ? ', ' : '', h('b', `@${se.handle}`), mockMarker(se)]),
              ),
            ),
          ),
          h('td', `${S().projects[t.projectId]?.name ?? ''} · ${t.title}`),
          h('td.dim.small', `Archived ${ago(at(ses) || Date.now())}`),
          h(
            'td.act',
            h(
              'button.btn.sm',
              {
                type: 'button',
                'aria-label': `Restore ${t.title}`,
                onclick: () => api(`/api/threads/${id}/restore`, {}).catch((e) => toast({ title: 'Couldn’t restore', text: e.message, level: 'blocking' })),
              },
              'Restore',
            ),
            h('a.btn.sm.ghost', { href: `#/t/${id}`, 'aria-label': `Open ${t.title}` }, 'Open'),
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
      h('span.small.dim', plural(list.length, 'conversation')),
    ),
    table,
  );
}

/** The conversation a thread belongs to: itself, or for a side or topic thread, the one it branched from. */
const convOf = (threadId) => {
  let id = threadId;
  for (let i = 0; i < 8 && ['side', 'topic'].includes(S().threads[id]?.kind) && S().threads[id].parentId; i++) id = S().threads[id].parentId;
  return id;
};
const lastActive = (se) => se.finishedAt ?? se.updatedAt ?? se.startedAt ?? 0;

/**
 * The idle conversations, most recent first, each with its idle agents (#3, #101). A conversation that has a card
 * above isn’t listed again, and idle side and topic threads’ forks aren’t listed at all (#121).
 */
function idleConversations(live, active) {
  const carded = new Set(active.map((se) => convOf(se.threadId)));
  const by = new Map();
  for (const se of live) {
    const t = S().threads[se.threadId];
    if (se.needs || busy(se) || t.kind === 'side' || t.kind === 'topic' || carded.has(t.id)) continue;
    by.set(t.id, [...(by.get(t.id) ?? []), se]);
  }
  return [...by]
    .map(([id, ses]) => ({ t: S().threads[id], ses: ses.sort((a, b) => lastActive(b) - lastActive(a)) }))
    .sort((a, b) => lastActive(b.ses[0]) - lastActive(a.ses[0]));
}

/** An idle conversation as one row: its agents’ rings and names, where it is, the last message, and when. */
function idleRow(c) {
  const node = h('li.ov-row');
  // Like a card, the whole row opens the conversation; the link is the real target for the keyboard.
  node.addEventListener('click', (e) => {
    if (e.target.closest('a, button, [role=menu]') || getSelection()?.toString()) return;
    navigate(hrefOf(node.dataset.key));
  });
  updateIdleRow(node, c, true);
  return node;
}

function updateIdleRow(node, { t, ses }, fresh = false) {
  const project = S().projects[t.projectId];
  const last = ses[0];
  const unread = ses.reduce((a, x) => a + (x.unread ?? 0), 0);
  const sig = JSON.stringify([
    t.title,
    project?.name,
    unread,
    ses.map((x) => [x.id, x.handle, isMock(x), x.state, x.ctx, x.subagents, x.lastMessage, lastActive(x)]),
  ]);
  if (!fresh && node.dataset.sig === sig) return;
  node.dataset.sig = sig;
  const when = lastActive(last);
  fill(
    node,
    h('span.ring-slot', rings(t)),
    h(
      'a.ov-row-link',
      { href: hrefOf(t.id) },
      h(
        'span.ov-row-who',
        ses.flatMap((x, i) => [i ? ', ' : '', h('b', `@${x.handle}`), mockMarker(x)]),
      ),
      h('span.small.dim.ov-row-where', `${project?.name ?? ''} · ${t.title}`),
    ),
    h('span.small.dim.ov-row-last', last.lastMessage ?? ''),
    // An unanswered block from an earlier turn stays quiet here too, as on a card (#69).
    h(
      'span.small.dim.ov-row-when',
      ...ses.map((x) => openAsksEl(x)),
      unread ? [`Finished ${ago(when || Date.now())} `, h('span.badge', String(unread))] : when ? ago(when) : '',
    ),
    h(
      'button.btn.icon.sm.ghost',
      {
        type: 'button',
        'aria-label': `Actions for ${t.title}`,
        'aria-haspopup': 'menu',
        onclick: (e) =>
          openMenu(
            e.currentTarget,
            [
              { label: 'Open conversation', icon: 'thread', run: () => navigate(hrefOf(t.id)) },
              { ...archiveItem(t), desc: 'Takes it and its agents off the overview. Restore any time from Archived.' },
            ],
            { label: `Actions for ${t.title}` },
          ),
      },
      icon('more'),
    ),
  );
}

/**
 * Archive conversation, for a menu (#101): it archives every agent’s session in it, its side threads’ forks too,
 * through the sessions’ own archive, so each keeps its transcript, and Restore brings them all back.
 */
function archiveItem(t) {
  // Restore in the toast undoes this archive only: an agent archived on its own before stays archived.
  const restore = (ids) =>
    Promise.all(ids.map((id) => api(`/api/sessions/${id}/restore`, {}))).catch((e) => toast({ title: 'Couldn’t restore', text: e.message, level: 'blocking' }));
  return {
    label: `Archive ${t.kind === 'room' ? 'room' : 'conversation'}`,
    icon: 'archive',
    desc: 'Stops its agents and takes it off the overview. Restore any time from Archived.',
    run: () =>
      api(`/api/threads/${t.id}/archive`, {})
        .then((r) => toast({ title: `Archived “${t.title}”`, action: { label: 'Restore', run: () => restore(r.archived ?? []) } }))
        .catch((e) => toast({ title: 'Couldn’t archive', text: e.message, level: 'blocking' })),
  };
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
  // The current step shows only when it says more than the state in the header (#3).
  const step = busy(se) && se.currentStep && !repeatsState(se) ? se.currentStep : '';
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
          // One line, so the cards in a row line up; the link’s text keeps the whole name (#3).
          h('span.small.dim.oc-where', `${project?.name ?? ''} · ${t.kind === 'topic' ? 'topic thread: ' : ''}${t.title}`),
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
          quick ?? h('a.btn.sm', { href: hrefOf(whereOf(se)), style: { alignSelf: 'flex-start' } }, 'Open conversation'),
        )
      : null,
    // Sections with nothing in them are left out (#3).
    step || (busy(se) && se.glimpse) ? sec('Current step', step ? h('p', step) : null, busy(se) && se.glimpse ? h('p.glimpse', se.glimpse) : null) : null,
    se.lastMessage ? sec('Last message', h('p.clamp2', se.lastMessage)) : null,
    se.toolCalls?.length
      ? sec(
          h('span', 'Tool calls ', h('span.dim', String(se.toolCount ?? 0))),
          h(
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
          ),
        )
      : null,
    se.agentMessages?.length ? sec(h('span', 'Agent messages ', h('span.dim', String(se.agentMessages.length))), agentMessages(se)) : null,
    se.subagents?.length
      ? sec(
          h('span', 'Subagents ', h('span.dim', String(se.subagents.length))),
          h(
            'ul.mini-list',
            se.subagents.map((s) =>
              h(
                'li',
                h('pb-ring', { name: s.name, state: s.state, ctx: String(s.ctx), size: 'xs' }),
                h('span.t', h('b', s.name), s.doing ? h('span.dim', ` ${s.doing}`) : null),
              ),
            ),
          ),
        )
      : null,
    h(
      'div.oc-sec.stats',
      h('div', h('span.label', 'Context'), h('b', `${se.ctx}%`)),
      h('div', h('span.label', 'Compactions'), h('b', String(se.compactions ?? 0))),
      h('div', h('span.label', busy(se) ? 'Running' : 'Started'), h('b', ago(se.startedAt).replace(' ago', ''))),
    ),
  );
}

/** Steps the header already says: its state, a wait, or nothing yet. */
const repeatsState = (se) =>
  /^(thinking|writing a reply|waiting for you|failed|stopping|idle since .*)$/i.test(se.currentStep ?? '') ||
  se.currentStep?.toLowerCase() === stateWord(se.state).toLowerCase();

function agentMessages(se) {
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
  // Its ask may be in a side thread (#121).
  const where = whereOf(se);
  if (kind === 'permission' || kind === 'denial' || kind === 'appsend') {
    const it = (S().items[where] ?? []).find((x) => x.id === se.needs.itemId);
    if (it?.status !== 'open') return null;
    const act = (action) =>
      api(`/api/threads/${where}/items/${it.id}/act`, { action }).catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
    const buttons =
      kind === 'permission' || kind === 'appsend'
        ? [
            h('button.btn.sm', { type: 'button', onclick: () => act('allow') }, 'Allow'),
            h('button.btn.sm', { type: 'button', onclick: () => act('deny') }, 'Don’t allow'),
          ]
        : [
            it.rules.once ? h('button.btn.sm', { type: 'button', onclick: () => act('once') }, 'Allow once and retry') : null,
            it.rules.always ? h('button.btn.sm', { type: 'button', onclick: () => act('always') }, `Always allow ${it.rules.alwaysWords}`) : null,
          ];
    return h(
      'div.col',
      it.detail ? h('pre.md-code.perm-detail', h('code', it.detail.slice(0, 400))) : null,
      h('div.row-flex.wrap', ...buttons, h('a.btn.sm.ghost', { href: hrefOf(where) }, 'Open conversation')),
    );
  }
  if (kind !== 'block') return null;
  const it = (S().items[where] ?? []).find((x) => x.id === se.needs.itemId);
  if (!it?.valid) return null;
  const b = it.block;
  // The revision this card shows: if the agent changes the block first, the answer is refused, not taken (#123).
  const revision = it.revision ?? 1;
  const act = (action, values) =>
    api(`/api/threads/${where}/items/${it.id}/act`, { action, values, revision }).catch((e) =>
      toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }),
    );
  if (b.type === 'confirm')
    return h(
      'div.row-flex.wrap',
      h('button.btn.sm', { type: 'button', onclick: () => act('confirm', {}) }, b.confirmLabel),
      h('button.btn.sm', { type: 'button', onclick: () => act('cancel', {}) }, b.cancelLabel ?? 'Cancel'),
      h('a.btn.sm.ghost', { href: hrefOf(where) }, 'Open conversation'),
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
    return [chips, h('div.row-flex', send, h('a.btn.sm.ghost', { href: hrefOf(where) }, 'Open conversation'))];
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
      // With background jobs running, Stop asks in the conversation whether to stop them too (#129): go there for it.
      ...(busy(se)
        ? [
            {
              label: 'Stop',
              icon: 'x',
              run: () =>
                stopSession(se)
                  .then((r) => r?.ask && navigate(`#/t/${se.threadId}`))
                  .catch((e) => toast({ title: `Couldn’t stop @${se.handle}`, text: e.message, level: 'blocking' })),
            },
          ]
        : []),
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
function conversationMenu(anchor, shown) {
  // The top bar may be older than the thread: archived since, say.
  const t = S().threads[shown.id] ?? shown;
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
      { label: 'Work', icon: 'file', desc: 'What its agents changed, ran and published', run: () => openWork(t.id) },
      {
        label: 'Permissions…',
        icon: 'gear',
        desc: room ? 'An agent’s mode, rules and folders here' : 'Its mode, rules and folders here',
        run: () => openPermissions({ threadId: t.id }),
      },
      ...telemetryItems(t),
      'hr',
      ...agentLines(t),
      ...(t.kind === 'side' || t.kind === 'topic'
        ? []
        : t.archived
          ? [
              {
                label: `Restore ${room ? 'room' : 'conversation'}`,
                icon: 'archive',
                desc: 'Brings back its agents, on the overview and in the sidebar',
                run: () => api(`/api/threads/${t.id}/restore`, {}).catch((e) => toast({ title: 'Couldn’t restore', text: e.message, level: 'blocking' })),
              },
            ]
          : [archiveItem(t)]),
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
 * Each agent in the conversation, with its backend, model, effort and state as text, with full model ids: what
 * its row in the sidebar says, for when the sidebar is hidden or the window is narrow (#60, #105). Choosing one
 * opens its persona.
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

export { mountThreads } from './threads-page.mjs';
export { renderMarkdown, toPlainText };

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
