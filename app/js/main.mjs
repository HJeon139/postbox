// Boot, routing, color mode, notifications, keyboard shortcuts and hover-card content.

import './ring.mjs';
import { onThemeChange } from './apps.mjs';
import { client, connect, hrefOf, itemsOf, load, needsYou, threadsOf } from './client.mjs';
import { $, h, icon } from './dom.mjs';
import { mountPane } from './pane.mjs';
import { canonical } from './pane-route.mjs';
import { paintStateWords, ringFor } from './ring.mjs';
import { openPalette } from './sheets.mjs';
import { mountEmptyProject, mountOverview, mountRail, mountThreads, nextNeedsYou, railHidden, toggleRail, topbar } from './shell.mjs';
import { focusComposer, mountComposer, mountTranscript } from './thread.mjs';
import { initHoverCards, mdNode, navigate, refind, route, say, setAttention, toast } from './ui.mjs';

const root = $('#root');
let mounted = [];
let current = null;
/** The open conversation’s right pane, which changes in place while you stay in the conversation. */
let pane = null;
/** @param {{ rebuild?: boolean }} [opts]  rebuild: the whole view, even when only the pane changed */
function render({ rebuild = false } = {}) {
  const r = route();
  const to = canonical(r, current);
  if (to) {
    navigate(to, { replace: true });
    return;
  }
  // Within a conversation, opening and closing a thread or Work changes only the pane: the transcript, the composer
  // and where you were in them stay as they are.
  if (!rebuild && pane && current?.view === 'thread' && r.view === 'thread' && r.threadId === current.threadId) {
    current = r;
    pane.set(r);
    document.getElementById('work-button')?.setAttribute('aria-pressed', String(r.slot === 'work'));
    view(r.threadId);
    return;
  }
  for (const m of mounted) m.destroy?.();
  mounted = [];
  pane = null;
  const archived = location.hash === '#/archived';
  if (r.view === 'thread' && !client.state.threads[r.threadId]) {
    navigate('#/');
    return;
  }
  current = r;
  if (r.view === 'project' || r.view === 'threads') {
    const project = client.state.projects[r.projectId];
    if (!project) {
      navigate('#/');
      return;
    }
    // A project opens on the conversation you were last in there, else its latest.
    if (r.view === 'project') {
      const target = lastIn(project.id) ?? latestIn(project.id);
      if (target) {
        // Replace, not push: Back from the conversation should skip the project link that led here.
        navigate(`#/t/${target}`, { replace: true });
        return;
      }
    }
    const rail = mountRail(null, { projectId: project.id, view: r.view });
    const page = r.view === 'threads' ? mountThreads(project.id) : mountEmptyProject(project.id);
    mounted.push(rail, page);
    root.replaceChildren(
      h(
        'div.app',
        { class: railHidden() ? 'rail-hidden' : '' },
        topbar({ title: r.view === 'threads' ? 'Threads' : '', projectId: project.id }),
        rail.el,
        h('div.main', rail.strip, page.el),
      ),
    );
    setAttention(needsYou().length, `${r.view === 'threads' ? 'Threads · ' : ''}${project.name}`);
    return;
  }
  if (r.view === 'overview') {
    const ov = mountOverview({ archived });
    mounted.push(ov);
    root.replaceChildren(h('div.app.no-rail', topbar({ title: archived ? 'Archived' : '' }), ov.el));
    setAttention(needsYou().length, 'Overview');
    return;
  }
  const t = client.state.threads[r.threadId];
  // Side threads and topic threads open in the panel beside their conversation.
  if (t.kind === 'side' || t.kind === 'topic') {
    navigate(hrefOf(t.id));
    return;
  }
  remember(t);
  const rail = mountRail(t.id);
  const tr = mountTranscript(t.id);
  const comp = mountComposer(t.id);
  const jumpBox = h('div.jump', { hidden: true });
  tr.setJump((n) => {
    jumpBox.hidden = !n;
    jumpBox.replaceChildren(h('button.btn.sm', { type: 'button', onclick: () => tr.scrollToEnd(true) }, icon('down', 'i-sm'), `Jump to latest · ${n} new`));
  });
  comp.el.querySelector('.col').style.position = 'relative';
  comp.el.querySelector('.col').prepend(jumpBox);
  // The right pane: a thread, Work, or both.
  pane = mountPane(t.id);
  mounted.push(rail, tr, comp, pane);
  const shell = h(
    'div.app',
    { class: railHidden() ? 'rail-hidden' : '' },
    topbar({ title: t.title, threadId: t.id }),
    rail.el,
    h('div.main', rail.strip, tr.el, comp.el),
    pane.el,
  );
  root.replaceChildren(shell);
  pane.set(r);
  paintWords();
  requestAnimationFrame(() => tr.settle());
  view(t.id);
  setAttention(needsYou().length, t.title);
}

// The conversation you were last in, per project, so a project’s tab returns you there.
function remember(t) {
  try {
    localStorage.setItem(`pb-last-${t.projectId}`, t.id);
  } catch {}
}
function lastIn(projectId) {
  let id = null;
  try {
    id = localStorage.getItem(`pb-last-${projectId}`);
  } catch {}
  const t = id && client.state.threads[id];
  return t && t.projectId === projectId && !t.archived && !t.deleting && t.kind !== 'side' && t.kind !== 'topic' ? id : null;
}
function latestIn(projectId) {
  const at = (t) => itemsOf(t.id).at(-1)?.at ?? t.createdAt ?? 0;
  return threadsOf(projectId)
    .filter((t) => !t.archived)
    .sort((a, b) => at(b) - at(a))[0]?.id;
}

// Tell the server which thread is open, so finished replies there don’t count as unread.
let viewTimer = 0;
function view(threadId) {
  clearInterval(viewTimer);
  const ping = () => {
    if (document.visibilityState !== 'visible' || route().threadId !== threadId) return;
    fetch(`/api/threads/${threadId}/view`, { method: 'POST' }).catch(() => {});
    // A thread open in the panel is being read too.
    const side = route().sideId;
    if (side) fetch(`/api/threads/${side}/view`, { method: 'POST' }).catch(() => {});
  };
  ping();
  viewTimer = setInterval(ping, 10000);
}
document.addEventListener('visibilitychange', () => {
  if (current?.threadId) view(current.threadId);
});

// ── Color mode ──────────────────────────────────────────────────────────────────────────

const media = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const pref = client.state?.settings?.theme ?? 'system';
  try {
    localStorage.setItem('pb-theme', pref);
  } catch {}
  const mode = pref === 'system' ? (media.matches ? 'light' : 'dark') : pref;
  if (document.documentElement.dataset.theme !== mode) {
    document.documentElement.dataset.theme = mode;
    onThemeChange();
  }
}
media.addEventListener('change', applyTheme);

// ── Live updates that change the shell ──────────────────────────────────────────────────

// Status words beside agent names follow their sessions, like the rings do.
const latestItemOf = (se) => {
  const list = client.state.items[se.threadId] ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].sessionId === se.id && (list[i].kind === 'agent' || list[i].kind === 'block')) return list[i].id;
  return null;
};
let wordsFrame = 0;
const paintWords = () => {
  cancelAnimationFrame(wordsFrame);
  wordsFrame = requestAnimationFrame(() => paintStateWords(document, client.state.sessions, latestItemOf));
};

client.on((ch) => {
  if (['session', 'item.add', 'load'].includes(ch.type)) paintWords();
  // The top bar keeps its rings between rebuilds, so they follow the session in place (issue #2).
  if (ch.type === 'session')
    for (const r of root.querySelectorAll(`header.topbar pb-ring[data-session="${CSS.escape(ch.data.id)}"]`)) ringFor(ch.data, r.getAttribute('size'), r);
  if (ch.type === 'settings' || ch.type === 'load') applyTheme();
  if (ch.type === 'notify') notify(ch.data);
  if (['thread', 'remove', 'project'].includes(ch.type) || (ch.type === 'session' && topbarChanged(ch.data))) refreshTop();
  if (ch.type === 'remove' && ch.data.kind === 'thread' && route().threadId === ch.data.id) navigate('#/');
  if (ch.type === 'connection') {
    if (client.connection === 'reconnecting' && client.attempts === 1) say('Connection lost. Reconnecting.');
    if (client.connection === 'open' && ch.was === 'reconnecting') say('Reconnected.');
  }
  setAttention(needsYou().length, current?.view === 'thread' ? (client.state.threads[current.threadId]?.title ?? 'Postbox') : 'Overview');
});

const topSig = new Map();
function topbarChanged(se) {
  const sig = `${se.needs?.kind}|${se.archived}|${se.deleting}`;
  const changed = topSig.get(se.id) !== sig;
  topSig.set(se.id, sig);
  return changed;
}
function refreshTop() {
  const old = root.querySelector('header.topbar');
  if (!old || !current) return;
  let next;
  if (current.view === 'thread') {
    const t = client.state.threads[current.threadId];
    if (!t) return;
    // Members changed (an agent joined or left): rebuild the whole view.
    const members = old.querySelectorAll('.present .ring-btn').length;
    if (members !== t.members.filter((id) => client.state.sessions[id] && !client.state.sessions[id].archived && !client.state.sessions[id].deleting).length) {
      render({ rebuild: true });
      return;
    }
    next = topbar({ title: t.title, threadId: t.id });
  } else if (current.projectId) next = topbar({ title: current.view === 'threads' ? 'Threads' : '', projectId: current.projectId });
  else next = topbar({ title: location.hash === '#/archived' ? 'Archived' : '' });
  // The keyboard stays where it was: focus on a control of the old bar moves to the same control in the new one.
  // A rename’s dialog can close before its change arrives, and return focus to the bar this replaces (#26).
  const back = document.activeElement && old.contains(document.activeElement) ? refind(document.activeElement) : null;
  old.replaceWith(next);
  back?.()?.focus();
}

function notify(d) {
  if (d.level !== 'blocking') return; // informational events are still badges, not toasts
  // In view: its conversation, or the side thread it’s in, open in the panel (#121).
  const r = route();
  if ((r.threadId === d.threadId || r.sideId === d.threadId) && document.visibilityState === 'visible') {
    say(`${d.title}. ${d.text}`);
    return;
  }
  const se = client.state.sessions[d.sessionId];
  toast({
    title: d.title,
    text: d.text,
    level: 'blocking',
    ring: se ? ringFor(se, 'sm') : null,
    action: { label: 'Go', run: () => navigate(hrefOf(d.threadId)) },
    timeout: 12000,
  });
}

// ── Keyboard ────────────────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    nextNeedsYou();
    return;
  }
  // ⌘\ shows or hides the sidebar.
  if (mod && e.key === '\\') {
    e.preventDefault();
    toggleRail();
    return;
  }
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
    return;
  }
  // Alt+↑/↓ moves between turns and blocks; Alt+End returns to the composer.
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const items = [...document.querySelectorAll('#main > .item')];
    if (!items.length) return;
    e.preventDefault();
    const at = items.findIndex((n) => n.contains(document.activeElement));
    const next = items[at < 0 ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  }
  if (e.altKey && e.key === 'End') {
    e.preventDefault();
    focusComposer();
  }
});

// ── Hover cards: citations and glossary terms ───────────────────────────────────────────

initHoverCards((trigger) => {
  const itemEl = trigger.closest('[data-key]');
  const threadId = trigger.closest('[data-thread]')?.dataset.thread;
  if (trigger.classList.contains('cite')) {
    const it = (client.state.items[threadId] ?? []).find((x) => x.id === itemEl?.dataset.key);
    const n = +trigger.dataset.cite;
    const s = it?.sources?.[n - 1];
    if (!s) return null;
    const arxiv = s.url?.match(/arxiv\.org\/abs\/([\d.]+)/)?.[1];
    return {
      label: `Source ${n}`,
      head: [
        h('span.label', `Source ${n}${arxiv ? ` · arXiv ${arxiv}` : ''}`),
        h('b', s.title),
        h('span.small.dim', [s.authors, s.year].filter(Boolean).join(' · ')),
      ],
      body: [
        s.note ? h('p', h('span.dim', 'Why it’s cited: '), s.note) : null,
        h(
          'div.hc-links',
          s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.url.replace(/^https?:\/\//, ''), ' ', icon('link', 'i-sm')) : null,
          h(
            'a',
            {
              href: `#src-${it.id}-${n}`,
              onclick: (e) => {
                e.preventDefault();
                document.getElementById(`src-${it.id}-${n}`)?.scrollIntoView({ block: 'center' });
              },
            },
            'Show in sources',
          ),
        ),
      ],
    };
  }
  const t = client.state.threads[threadId];
  const g = { ...(client.state.glossary[t?.parentId] ?? {}), ...(client.state.glossary[threadId] ?? {}) }[trigger.dataset.term];
  if (!g)
    return {
      label: 'Not defined yet',
      head: [h('span.label', 'Glossary'), h('b', trigger.textContent)],
      body: [h('p.dim', 'Not defined yet. The agent has been asked to define it.')],
    };
  return {
    label: `Glossary: ${g.term}`,
    head: [h('span.label', 'Glossary'), h('b', g.term)],
    body: [mdNode(g.definition), h('span.small.dim', `Defined by @${g.by}${g.source ? ` · ${g.source}` : ''}`)],
  };
});

// ── Boot ────────────────────────────────────────────────────────────────────────────────

addEventListener('hashchange', () => render());
// Asked to open what’s already open (Work at the same turn): go there again.
addEventListener('pb-pane', (e) => {
  const r = route();
  if (pane && current?.view === 'thread' && r.threadId === current.threadId) pane.set(r, /** @type {CustomEvent} */ (e).detail);
});
try {
  await load();
  applyTheme();
  connect();
  render();
} catch (e) {
  root.replaceChildren(h('div', { style: { padding: '24px' } }, h('h1.title', 'Postbox couldn’t start'), h('p', e.message)));
}
