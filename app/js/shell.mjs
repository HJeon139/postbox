// The shell: the top bar, the rail (conversations and rooms with rings, and the open conversation’s agents), the phone
// ring strip, the places menu, and a project with no conversation yet. There’s no overview (#320): Postbox opens one.

import { installNote } from '/shared/agent-facts.mjs';
import { renderMarkdown, toPlainText } from '/shared/markdown.mjs';
import { isMock, mockMarker } from './agent-facts.mjs';
import { agentMenuLines } from './agent-menu-lines.mjs';
import { agentsSection } from './agents.mjs';
import { api, busy, client, needsYou, sessionsOf, threadState, threadsOf, topicsOf } from './client.mjs';
import { fill, h, icon, syncList } from './dom.mjs';
import { nextNeedsYou } from './needs-nav.mjs';
import { openPermissions } from './permissions.mjs';
import { projectPlaces } from './places-menu.mjs';
import { railHidden, railShown, toggleRail } from './rail-collapse.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { confirmDeleteThread, openNewAgent, openNewThread, openPalette, openRename, openSettings } from './sheets.mjs';
import { recordingBadge, telemetryItems } from './telemetry.mjs';
import { closeWork, navigate, openMenu, openWork, route, toast, undoToast } from './ui.mjs';

export { railHidden, toggleRail };

const S = () => client.state;

/**
 * The top bar: the places menu, the path to the open conversation and its two views, and the global actions. The
 * agents, their rings and their quick panels are in the sidebar’s Agents section (#105, #320).
 */
/** A conversation’s agents that are here: neither archived nor being deleted. */
export const liveMembers = (t) => t.members.filter((id) => S().sessions[id] && !S().sessions[id].archived && !S().sessions[id].deleting).join(',');

export function topbar({ title = '', threadId = null, projectId = null }) {
  const t = threadId ? S().threads[threadId] : null;
  const pid = t?.projectId ?? projectId;
  const project = pid ? S().projects[pid] : null;
  const n = needsYou().length;
  const needsIn = (id) => needsYou().filter((se) => S().threads[se.threadId]?.projectId === id).length;
  const projects = Object.values(S().projects);
  // The Postbox mark opens the places menu: every project, from anywhere.
  const places = (e) =>
    openMenu(
      e.currentTarget,
      [
        { heading: 'Projects' },
        ...projectPlaces(projects, pid, needsIn, (id) => navigate(`#/p/${id}`)),
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
        'aria-label': `Postbox: go to a project${n ? ` (${n} need you)` : ''}`,
        onclick: places,
      },
      h('span.mark', { 'aria-hidden': 'true' }),
      h('span.hide-sm', 'Postbox'),
      icon('down', 'i-sm'),
    ),
    h(
      'span.crumbs',
      // The crumb above the title (.up) is the first thing the top bar drops for room (#72).
      project ? [icon('right', `i-sm${up}`), h(`a.crumb${up}`, { href: `#/p/${project.id}` }, project.name)] : null,
      title ? [icon('right', 'i-sm'), h('span.title', title), recordingBadge(t)] : null,
    ),
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
  // Who it was drawn for: main.mjs rebuilds the view when an agent joins or leaves, and only then.
  if (t) bar.dataset.members = liveMembers(t);
  fitter?.observe(bar);
  // Fitted once it’s on the page too: the observer’s first call waits for a frame, which a hidden tab can hold back.
  queueMicrotask(() => fitTopbar(bar));
  return bar;
}

/** The folded rings’ menu: each agent with its state and what it runs with, now, leading to its quick panel. */
// ── Fitting the top bar (#72) ───────────────────────────────────────────────────────────
// Only a narrow window is short of room. Then the top bar drops, in this order: the project above the conversation’s
// title, then the demo banner’s sentence (it folds to “Demo”). It’s measured, not a fixed breakpoint, because what
// fits depends on the title.

const DROPS = ['crumb', 'demo'];
/** The room the open conversation’s title keeps, in pixels, before the top bar drops anything for it. */
const TITLE_ROOM = 96;

/** Drops the fewest parts that let the top bar fit. */
function fitTopbar(bar) {
  if (!bar.isConnected) return;
  // The title itself: the recording badge after it, empty while nothing records, has no room to keep.
  const title = bar.querySelector('.crumbs > .title');
  const fits = () => bar.scrollWidth <= bar.clientWidth && (!title || title.clientWidth >= Math.min(title.scrollWidth, TITLE_ROOM));
  let n = 0;
  bar.dataset.drop = '';
  while (n < DROPS.length && !fits()) bar.dataset.drop = DROPS.slice(0, ++n).join(' ');
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
    // fill() re-appends the kept Agents section, which drops focus inside it; give it back to the same node (F1).
    const had = el.contains(document.activeElement) ? document.activeElement : null;
    paintRail();
    if (had instanceof HTMLElement && had.isConnected && document.activeElement !== had) had.focus({ preventScroll: true });
  };
  const paintRail = () => {
    const t = threadId ? S().threads[threadId] : null;
    const projectId = t?.projectId ?? pid ?? Object.keys(S().projects)[0];
    const threads = threadsOf(projectId).filter((x) => !x.archived);
    const others = Object.values(S().projects).filter((p) => p.id !== projectId);
    const otherNeeds = others.map((p) => [p, needsYou().filter((se) => S().threads[se.threadId]?.projectId === p.id).length]).filter(([, n]) => n);
    fill(
      el,
      ...otherNeeds.map(([p, n]) =>
        h(
          'a.row',
          { href: `#/p/${p.id}`, style: { minHeight: '32px' } },
          h('span.g.g-needs', { 'aria-hidden': 'true' }),
          h('span.name.small', `${p.name} · ${n} need${n === 1 ? 's' : ''} you`),
        ),
      ),
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
        // What isn’t installed, which the overview used to say (#320): nothing while every backend is there.
        installLine(),
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
      threads,
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

/** What isn’t installed, as the overview used to say (#320); null while every backend is there. */
export function installLine() {
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
      ...agentMenuLines(
        sessionsOf(t.id).filter((x) => !x.archived),
        (personaId) => openSettings('personas', personaId),
        anchor,
      ),
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
