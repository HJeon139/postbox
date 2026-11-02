// Boot, routing, color mode, notifications and hover-card content. Keyboard shortcuts are in keys.mjs.

import './ring.mjs';
import { onThemeChange } from './apps.mjs';
import { client, connect, hrefOf, load, needsYou } from './client.mjs';
import { $, h, icon } from './dom.mjs';
import './focus-clear.mjs';
import { hoverContent } from './hover-content.mjs';
import './keys.mjs';
import { goHome, lastIn, latestIn, remember } from './last-place.mjs';
import { mountPane } from './pane.mjs';
import { canonical } from './pane-route.mjs';
import { ringFor } from './ring.mjs';
import { liveMembers, mountEmptyProject, mountRail, mountThreads, railHidden, topbar } from './shell.mjs';
import { paintWords, wordsChanged } from './state-words.mjs';
import { mountComposer, mountTranscript } from './thread.mjs';
import { initHoverCards, navigate, refind, route, say, setAttention, toast } from './ui.mjs';

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
  // There’s no overview or Archived page (#320): Postbox opens the conversation you were last in, else a project’s.
  if (r.view === 'overview') return goHome(root);
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

client.on((ch) => {
  wordsChanged(ch);
  if (ch.type === 'settings' || ch.type === 'load') applyTheme();
  if (ch.type === 'notify') notify(ch.data);
  if (['thread', 'remove', 'project'].includes(ch.type) || (ch.type === 'session' && topbarChanged(ch.data))) refreshTop();
  if (ch.type === 'remove' && ch.data.kind === 'thread' && route().threadId === ch.data.id) navigate('#/');
  if (ch.type === 'connection') {
    if (client.connection === 'reconnecting' && client.attempts === 1) say('Connection lost. Reconnecting.');
    if (client.connection === 'open' && ch.was === 'reconnecting') say('Reconnected.');
  }
  setAttention(needsYou().length, current?.view === 'thread' ? (client.state.threads[current.threadId]?.title ?? 'Postbox') : 'Postbox');
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
    if (old.dataset.members !== liveMembers(t)) {
      render({ rebuild: true });
      return;
    }
    next = topbar({ title: t.title, threadId: t.id });
  } else if (current.projectId) next = topbar({ title: current.view === 'threads' ? 'Threads' : '', projectId: current.projectId });
  else next = topbar({});
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

// ── Hover cards: citations and glossary terms ───────────────────────────────────────────

initHoverCards(hoverContent);

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
