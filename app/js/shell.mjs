// The shell: top bar, rail (threads and rooms with rings), the phone ring strip, and the overview —
// one column per live session, with quick answers, tool calls, subagents, agent messages and stats.

import { renderMarkdown, toPlainText } from '/shared/markdown.mjs';
import { api, busy, client, hrefOf, liveSessions, needsYou, sessionsOf, threadState, threadsOf, topicsOf } from './client.mjs';
import { ago, fill, h, icon, plural, syncList, timeOf } from './dom.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { confirmDelete, confirmDeleteThread, openNewAgent, openNewThread, openPalette, openRename, openSettings } from './sheets.mjs';
import { navigate, openMenu, route, toast, undoToast } from './ui.mjs';

const S = () => client.state;

/**
 * The top bar: Postbox, then Overview and each project as tabs, the open conversation’s title and who’s in
 * it, and the global actions. On a phone the tabs fold into one menu button.
 */
export function topbar({ title = '', threadId = null, projectId = null }) {
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
            return h('span.who-chip', r, h('b', `@${se.handle}`));
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
  return h(
    'header.topbar',
    h(
      'button.brand',
      { type: 'button', 'aria-haspopup': 'menu', 'aria-label': `Postbox: go to the overview or a project${n ? ` (${n} need you)` : ''}`, onclick: places },
      h('span.mark', { 'aria-hidden': 'true' }),
      h('span.hide-sm', 'Postbox'),
      icon('down', 'i-sm'),
    ),
    h(
      'span.crumbs',
      project
        ? [icon('right', 'i-sm'), h('a.crumb', { href: `#/p/${project.id}` }, project.name)]
        : [icon('right', 'i-sm'), h(t || title ? 'a.crumb' : 'span.title', t || title ? { href: '#/' } : {}, 'Overview')],
      title ? [icon('right', 'i-sm'), h('span.title', title)] : null,
    ),
    present,
    t
      ? h(
          'button.btn.icon.sm.ghost',
          { type: 'button', 'aria-haspopup': 'menu', 'aria-label': `Actions for ${t.title}`, onclick: (e) => conversationMenu(e.currentTarget, t) },
          icon('more'),
        )
      : null,
    h(
      'div.top-actions',
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
    const project = S().projects[projectId];
    const threads = threadsOf(projectId).filter((x) => !x.archived);
    const others = Object.values(S().projects).filter((p) => p.id !== projectId);
    const otherNeeds = others.map((p) => [p, needsYou().filter((se) => S().threads[se.threadId]?.projectId === p.id).length]).filter(([, n]) => n);
    const archived = Object.values(S().sessions).filter((se) => se.archived && !se.deleting).length;
    fill(
      el,
      h(
        'button.btn.ghost.rail-proj',
        {
          type: 'button',
          'aria-haspopup': 'menu',
          style: { justifyContent: 'flex-start', height: 'auto' },
          onclick: (e) =>
            openMenu(
              e.currentTarget,
              [
                { heading: 'Projects' },
                ...Object.values(S().projects).map((p) => ({
                  label: p.name,
                  desc: p.folder,
                  icon: p.id === projectId ? 'check' : 'folder',
                  run: () => navigate(`#/p/${p.id}`),
                })),
                'hr',
                { label: 'New project…', icon: 'plus', run: () => openSettings('projects') },
              ],
              { label: 'Projects' },
            ),
        },
        icon('folder'),
        h(
          'span.grow',
          { style: { textAlign: 'left' } },
          h('span.title', { style: { fontSize: '14px', display: 'block' } }, project?.name ?? ''),
          h('span.small.dim.mono', project?.folder?.replace(/^\/Users\/[^/]+/, '~') ?? ''),
        ),
        icon('down'),
      ),
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
    if (['session', 'thread', 'project', 'load', 'remove'].includes(ch.type)) {
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
  const who = t.kind === 'room' ? ses.map((x) => `@${x.handle}`).join(', ') : `@${main?.handle ?? '—'}`;
  const sig = JSON.stringify([t.title, who, main?.state, unread, ses.map((x) => x.id)]);
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
  el.append(headEl, grid, archive);
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
    if (!live.length) grid.replaceChildren(h('div.ov-empty', 'No live sessions. Open a project above, or create an agent.'));
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
    if (!['session', 'thread', 'load', 'remove', 'project', 'app'].includes(ch.type)) return;
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
          h('td', h('span.row-flex', ring, h('b', `@${se.handle}`))),
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
  const sig = JSON.stringify([
    se.state,
    se.needs,
    se.currentStep,
    se.lastMessage,
    se.toolCount,
    se.toolCalls,
    se.agentMessages,
    se.subagents,
    se.compactions,
    se.ctx,
    se.unread,
    t.title,
  ]);
  if (!fresh && node.dataset.sig === sig) return;
  node.dataset.sig = sig;
  node.classList.toggle('needs', !!se.needs);
  node.setAttribute('aria-label', `@${se.handle}, ${stateWord(se.state).toLowerCase()}`);
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
          h('b', `@${se.handle}`),
          h('span.small.dim', `${project?.name ?? ''} · ${t.kind === 'topic' ? 'thread: ' : ''}${t.title}`),
        ),
        stateLine,
      ),
      h(
        'button.btn.icon.sm.ghost',
        { type: 'button', 'aria-label': `Session actions for @${se.handle}`, 'aria-haspopup': 'menu', onclick: (e) => sessionMenu(e.currentTarget, se) },
        icon('more'),
      ),
    ),
    se.needs
      ? sec(
          se.needs.kind === 'failed' ? 'Failed' : 'Needs you',
          h('p', se.needs.text),
          quick ?? h('a.btn.sm', { href: `#/t/${se.threadId}`, style: { alignSelf: 'flex-start' } }, 'Open thread'),
        )
      : null,
    sec('Current step', h('p', { class: busy(se) ? '' : 'dim' }, se.currentStep || '—')),
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

/** Answer a simple choice or confirm right on the card. */
function quickAnswer(se) {
  if (se.needs?.kind !== 'block') return null;
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
      h('a.btn.sm.ghost', { href: `#/t/${se.threadId}` }, 'Open thread'),
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
    return [chips, h('div.row-flex', send, h('a.btn.sm.ghost', { href: `#/t/${se.threadId}` }, 'Open thread'))];
  }
  return null;
}

export function sessionMenu(anchor, se) {
  openMenu(
    anchor,
    [
      { label: 'Open thread', icon: 'thread', run: () => navigate(`#/t/${se.threadId}`) },
      { label: `Edit @${se.handle} persona`, icon: 'edit', kbd: 'Personas', run: () => openSettings('personas', se.personaId) },
      ...(busy(se) ? [{ label: 'Stop', icon: 'x', run: () => api(`/api/sessions/${se.id}/stop`, {}) }] : []),
      'hr',
      {
        label: 'Archive session',
        icon: 'archive',
        desc: 'Stops it; keeps the thread read-only. Restore any time.',
        run: () =>
          api(`/api/sessions/${se.id}/archive`, {}).then(() =>
            toast({ title: `Archived @${se.handle}’s session`, action: { label: 'Restore', run: () => api(`/api/sessions/${se.id}/restore`, {}) } }),
          ),
      },
      { label: 'Delete session…', icon: 'trash', danger: true, desc: 'Erases the thread and its apps. The persona stays.', run: () => confirmDelete(se) },
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
      'hr',
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
